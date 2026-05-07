require('dotenv').config();
const mqtt   = require('mqtt');
const { MongoClient } = require('mongodb');
const https  = require('https');
const { GoogleAuth } = require('google-auth-library');

const TOPIC_UID   = "doormotic/uid";
const TOPIC_AUTH  = "doormotic/autorizzazioni/porta1";
const TOPIC_STATO = "doormotic/stato/porta1";

// ══════════════════════════════════════════════════════════════════
// MQTT
// ══════════════════════════════════════════════════════════════════
const mqttClient = mqtt.connect(`mqtts://${process.env.MQTT_BROKER}:${process.env.MQTT_PORT}`, {
    username:           process.env.MQTT_USER,
    password:           process.env.MQTT_PASSWORD,
    rejectUnauthorized: true,
    reconnectPeriod:    5000,
});

mqttClient.on('connect', () => {
    console.log("✅ MQTT connesso");
    mqttClient.subscribe(TOPIC_UID, (err) => {
        if (err) console.error("❌ Errore subscribe uid:", err.message);
        else     console.log(`👂 In ascolto su: ${TOPIC_UID}`);
    });
    mqttClient.subscribe(TOPIC_STATO, (err) => {
        if (err) console.error("❌ Errore subscribe stato:", err.message);
        else     console.log(`👂 In ascolto su: ${TOPIC_STATO}`);
    });
});

mqttClient.on('error',     (err) => console.error("❌ Errore MQTT:", err.message));
mqttClient.on('close',     ()    => console.warn("⚠️  MQTT connessione chiusa"));
mqttClient.on('offline',   ()    => console.warn("⚠️  MQTT offline"));
mqttClient.on('reconnect', ()    => console.log("🔄 MQTT riconnessione..."));

// ══════════════════════════════════════════════════════════════════
// MONGODB
// ══════════════════════════════════════════════════════════════════
let db;

async function connectDB() {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    db = client.db(process.env.DB_NAME);
    console.log("✅ MongoDB connesso — DB:", process.env.DB_NAME);
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════
function nowItaly() {
    const d = new Date();
    d.setHours(d.getHours() + 2);
    return d;
}

async function getOrCreateTag(uid) {
    const tags = db.collection("tags");
    let tag = await tags.findOne({ _id: uid });
    if (!tag) {
        tag = {
            _id:             uid,
            tag_id:          uid,
            label:           "Sconosciuto",
            has_door_access: false,
            created_at:      new Date()
        };
        await tags.insertOne(tag);
        console.log(`🆕 Nuovo tag registrato: ${uid} → Sconosciuto`);
    }
    return tag;
}

async function saveLog(tag, azione) {
    await db.collection("accesses").insertOne({
        username:  tag.label,
        tag_id:    tag.tag_id,
        azione:    azione,
        source:    "RFID",
        timestamp: nowItaly()
    });
}

async function updateDoorState(aperta) {
    await db.collection("door_state").updateOne(
        { _id: "porta1" },
        { $set: { aperta, updated_at: new Date() } },
        { upsert: true }
    );
}

// ══════════════════════════════════════════════════════════════════
// FCM v1 — Notifiche push per admin
// ══════════════════════════════════════════════════════════════════
async function getFcmAccessToken() {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const auth = new GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    const client = await auth.getClient();
    const token  = await client.getAccessToken();
    return token.token;
}

async function sendFcmNotification(fcmToken, title, body) {
    const projectId   = process.env.FCM_PROJECT_ID;
    const accessToken = await getFcmAccessToken();
    const payload = JSON.stringify({
        message: {
            token: fcmToken,
            notification: { title, body },
            android: { priority: "high", notification: { sound: "default" } }
        }
    });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'fcm.googleapis.com',
            path:     `/v1/projects/${projectId}/messages:send`,
            method:   'POST',
            headers: {
                'Authorization':  `Bearer ${accessToken}`,
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) resolve();
                else reject(new Error(`FCM error ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function notifyAdmins(title, body) {
    try {
        const admins = await db.collection("users").find(
            { is_admin: true, fcm_token: { $exists: true } },
            { projection: { fcm_token: 1 } }
        ).toArray();
        if (admins.length === 0) {
            console.log("⚠️  Nessun admin con token FCM");
            return;
        }
        for (const admin of admins) {
            if (admin.fcm_token) {
                try {
                    await sendFcmNotification(admin.fcm_token, title, body);
                    console.log(`🔔 Notifica inviata all'admin`);
                } catch (fcmErr) {
                    console.error(`❌ Errore FCM: ${fcmErr.message}`);
                }
            }
        }
    } catch (err) {
        console.error("❌ Errore notifyAdmins:", err.message);
    }
}

// ══════════════════════════════════════════════════════════════════
// HANDLER UID — gestione accesso RFID
// ══════════════════════════════════════════════════════════════════
async function handleRfidMessage(rawPayload) {
    let uid, statoAttuale;
    try {
        const parsed = JSON.parse(rawPayload);
        uid          = String(parsed.uid).trim().toUpperCase();
        statoAttuale = parsed.stato === "true" || parsed.stato === true;
    } catch (e) {
        console.warn("⚠️  Payload malformato:", rawPayload);
        return;
    }
    if (!uid) { console.warn("⚠️  UID mancante"); return; }

    console.log(`🏷️  Tag: ${uid} | Stato attuale: ${statoAttuale ? "Aperta" : "Chiusa"}`);

    const tag = await getOrCreateTag(uid);

    if (!tag.has_door_access) {
        console.log(`🚫 Accesso negato: ${tag.label} (${uid})`);
        await saveLog(tag, "Non autorizzato");
        mqttClient.publish(TOPIC_AUTH, "unauth");
        const nome = tag.label === "Sconosciuto" ? `Tag sconosciuto (${uid})` : tag.label;
        await notifyAdmins("🚫 Accesso negato", `${nome} ha tentato di accedere`);
        return;
    }

    // Autorizzato — il log registra l'azione che il servo sta per fare
    const azioneLog = statoAttuale ? "Bloccata" : "Aperta";
    await saveLog(tag, azioneLog);
    mqttClient.publish(TOPIC_AUTH, "auth");
    console.log(`✅ ${tag.label} (${uid}) → auth | Azione: ${azioneLog}`);

    const nome = tag.label === "Sconosciuto" ? `Tag ${uid}` : tag.label;
    await notifyAdmins(
        azioneLog === "Aperta" ? "🔓 Porta aperta" : "🔒 Porta chiusa",
        azioneLog === "Aperta" ? `${nome} ha aperto la porta` : `${nome} ha chiuso la porta`
    );
}

// ══════════════════════════════════════════════════════════════════
// HANDLER STATO PORTA — risposta ESP32 a "richiesta stato"
// ══════════════════════════════════════════════════════════════════
async function handleStatoPorta(payload) {
    // Ignora i messaggi mandati dal Worker stesso
    if (payload === "richiesta stato") return;

    const aperta = payload === "aperta";
    await updateDoorState(aperta);
    console.log(`🚪 Stato porta: ${aperta ? "Aperta" : "Chiusa"}`);
}

// ══════════════════════════════════════════════════════════════════
// RICHIESTA STATO PERIODICA — ogni 4 secondi
// ══════════════════════════════════════════════════════════════════
function startStatoPolling() {
    setInterval(() => {
        mqttClient.publish(TOPIC_STATO, "richiesta stato");
    }, 4000);
}

// ══════════════════════════════════════════════════════════════════
// AVVIO
// ══════════════════════════════════════════════════════════════════
(async () => {
    try {
        await connectDB();
    } catch (err) {
        console.error("❌ Errore MongoDB:", err.message);
        process.exit(1);
    }

    mqttClient.on('message', async (topic, message) => {
        const payload = message.toString().trim();
        try {
            if (topic === TOPIC_UID) {
                await handleRfidMessage(payload);
            } else if (topic === TOPIC_STATO) {
                await handleStatoPorta(payload);
            }
        } catch (err) {
            console.error("❌ Errore handler:", err.message);
        }
    });

    startStatoPolling();

    console.log("\n══════════════════════════════════");
    console.log("  DOORmotic Worker avviato");
    console.log(`  UID:    ${TOPIC_UID}`);
    console.log(`  Auth:   ${TOPIC_AUTH}`);
    console.log(`  Stato:  ${TOPIC_STATO}`);
    console.log("══════════════════════════════════\n");
})();