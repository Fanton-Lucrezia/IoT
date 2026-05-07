require('dotenv').config();
const mqtt   = require('mqtt');
const { MongoClient } = require('mongodb');
const https  = require('https');
const { GoogleAuth } = require('google-auth-library');

// Ora italiana (CEST UTC+2, CET UTC+1)
// Cambia l'offset a 1 in inverno
function nowItaly() {
    const d = new Date();
    d.setHours(d.getHours() + 2);
    return d;
}

const TOPIC_IN    = "doormotic/uid";
const TOPIC_OUT   = "doormotic/comandi/porta1";
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
    mqttClient.subscribe(TOPIC_IN, (err) => {
        if (err) console.error("❌ Errore subscribe uid:", err.message);
        else     console.log(`👂 In ascolto su: ${TOPIC_IN}`);
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

async function updateDoorState(statoAperta) {
    await db.collection("door_state").updateOne(
        { _id: "porta1" },
        { $set: { aperta: statoAperta, updated_at: new Date() } },
        { upsert: true }
    );
}

async function saveLog(tag, azione) {
    const now = nowItaly();
    await db.collection("accesses").insertOne({
        username:  tag.label,
        tag_id:    tag.tag_id,
        azione:    azione,
        source:    "RFID",
        timestamp: now
    });
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
            android: {
                priority: "high",
                notification: { sound: "default" }
            }
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
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    reject(new Error(`FCM error ${res.statusCode}: ${data}`));
                }
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
            console.log("⚠️  Nessun admin con token FCM trovato");
            return;
        }

        for (const admin of admins) {
            if (admin.fcm_token) {
                console.log(`🔑 Token FCM (primi 20 char): ${admin.fcm_token.substring(0, 20)}...`);
                try {
                    await sendFcmNotification(admin.fcm_token, title, body);
                    console.log(`🔔 Notifica inviata all'admin`);
                } catch (fcmErr) {
                    console.error(`❌ Errore FCM dettagliato: ${fcmErr.message}`);
                }
            }
        }
    } catch (err) {
        console.error("❌ Errore notifica admin:", err.message);
    }
}

// ══════════════════════════════════════════════════════════════════
// HANDLER RFID
// ══════════════════════════════════════════════════════════════════
async function handleRfidMessage(rawPayload) {
    let uid, statoAttuale;
    try {
        const parsed = JSON.parse(rawPayload);
        uid          = String(parsed.uid).trim().toUpperCase();
        statoAttuale = Boolean(parsed.stato);
    } catch (e) {
        console.warn("⚠️  Payload malformato (JSON non valido):", rawPayload);
        return;
    }
    if (!uid) {
        console.warn("⚠️  Campo 'uid' mancante:", rawPayload);
        return;
    }

    console.log(`🏷️  Tag: ${uid} | Stato porta attuale: ${statoAttuale ? "Aperta" : "Chiusa"}`);

    const tag = await getOrCreateTag(uid);

    if (!tag.has_door_access) {
        // Accesso NEGATO — non aggiornare lo stato porta nel DB
        console.log(`🚫 Accesso negato per: ${tag.label} (${uid})`);
        await saveLog(tag, "Non autorizzato");
        mqttClient.publish(TOPIC_OUT, "false");
        console.log(`📤 Pubblicato: false → ${TOPIC_OUT}`);
        const nomeNegato = tag.label === "Sconosciuto" ? `Tag sconosciuto (${uid})` : tag.label;
        await notifyAdmins(
            "🚫 Accesso negato",
            `${nomeNegato} ha tentato di accedere senza autorizzazione`
        );
        return;
    }

    // Accesso CONSENTITO — il servo si muoverà, il nuovo stato è l'opposto di quello attuale
    const nuovoStato = !statoAttuale;
    await updateDoorState(nuovoStato);

    const azioneLog = nuovoStato ? "Aperta" : "Bloccata";
    await saveLog(tag, azioneLog);
    mqttClient.publish(TOPIC_OUT, nuovoStato);
    console.log(`✅ ${tag.label} (${uid}) → autorizzato | Pubblicato: true → ${TOPIC_OUT}`);

    const nomeAutorizzato = tag.label === "Sconosciuto" ? `Tag ${uid}` : tag.label;
    const messaggioNotifica = nuovoStato
        ? `${nomeAutorizzato} ha aperto la porta`
        : `${nomeAutorizzato} ha chiuso la porta`;
    await notifyAdmins(
        nuovoStato ? "🔓 Porta aperta" : "🔒 Porta chiusa",
        messaggioNotifica
    );
}

// ══════════════════════════════════════════════════════════════════
// PUBLISH STATO PERIODICO (ogni 3 secondi)
// ══════════════════════════════════════════════════════════════════
async function startStatoInterval() {
    setInterval(async () => {
        try {
            const doc   = await db.collection("door_state").findOne({ _id: "porta1" });
            const stato = doc ? doc.aperta : false;
            mqttClient.publish(TOPIC_STATO, stato ? true : false);
        } catch (err) {
            console.error("❌ Errore publish stato periodico:", err.message);
        }
    }, 3000);
}

// ══════════════════════════════════════════════════════════════════
// AVVIO
// ══════════════════════════════════════════════════════════════════
(async () => {
    try {
        await connectDB();
    } catch (err) {
        console.error("❌ Errore connessione MongoDB:", err.message);
        process.exit(1);
    }

    mqttClient.on('message', async (topic, message) => {
        const payload = message.toString().trim();
        try {
            if (topic === TOPIC_IN) {
                await handleRfidMessage(payload);
            }
        } catch (err) {
            console.error("❌ Errore handler:", err.message);
        }
    });

    await startStatoInterval();

    console.log("\n══════════════════════════════════");
    console.log("  DOORmotic Worker avviato");
    console.log(`  Ascolto su:  ${TOPIC_IN}`);
    console.log(`  Risponde su: ${TOPIC_OUT}`);
    console.log(`  Stato su:    ${TOPIC_STATO}`);
    console.log("══════════════════════════════════\n");
})();