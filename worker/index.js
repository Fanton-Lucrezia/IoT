require('dotenv').config();
const mqtt        = require('mqtt');
const { MongoClient } = require('mongodb');
const admin       = require('firebase-admin');

// ── Firebase Admin SDK ────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
console.log("✅ Firebase Admin inizializzato");

const TOPIC_IN    = "doormotic/uid";
const TOPIC_OUT   = "doormotic/comandi/porta1";
const TOPIC_STATO = "doormotic/stato/porta1";

const mqttClient = mqtt.connect(`mqtts://${process.env.MQTT_BROKER}:${process.env.MQTT_PORT}`, {
    username:           process.env.MQTT_USER,
    password:           process.env.MQTT_PASSWORD,
    rejectUnauthorized: true,
    reconnectPeriod:    5000,
});

mqttClient.on('connect', () => {
    console.log("✅ MQTT connesso");
    mqttClient.subscribe(TOPIC_IN, (err) => {
        if (err) console.error("❌ Errore subscribe:", err.message);
        else     console.log(`👂 In ascolto su: ${TOPIC_IN}`);
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

let db;

async function connectDB() {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    db = client.db(process.env.DB_NAME);
    console.log("✅ MongoDB connesso — DB:", process.env.DB_NAME);
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

async function updateDoorState(statoAperta) {
    await db.collection("door_state").updateOne(
        { _id: "porta1" },
        { $set: { aperta: statoAperta, updated_at: new Date() } },
        { upsert: true }
    );
}

async function saveLog(tag, azione) {
    const now = new Date();
    await db.collection("accesses").insertOne({
        username:  tag.label,
        tag_id:    tag.tag_id,
        azione:    azione,
        source:    "RFID",
        timestamp: now
    });
}

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

    console.log(`🏷️  Tag: ${uid} | Stato porta: ${statoAttuale ? "Aperta" : "Chiusa"}`);

    await updateDoorState(statoAttuale);

    const tag = await getOrCreateTag(uid);

    if (!tag.has_door_access) {
        console.log(`🚫 Accesso negato per: ${tag.label} (${uid})`);
        await saveLog(tag, "Non autorizzato");
        mqttClient.publish(TOPIC_OUT, "false");
        console.log(`📤 Pubblicato: false → ${TOPIC_OUT}`);
        await notifyAdmins(
            "🚫 Accesso negato",
            `Tag ${uid} ha tentato di accedere senza autorizzazione`
        );
        return;
    }

    // L'ESP32 gestisce apri/chiudi autonomamente in base al suo stato interno.
    // Il log registra l'azione che l'ESP32 sta per fare (opposta allo stato attuale).
    const azioneLog = statoAttuale ? "Aperta" : "Bloccata";
    await saveLog(tag, azioneLog);
    mqttClient.publish(TOPIC_OUT, "true");
    console.log(`✅ ${tag.label} (${uid}) → autorizzato | Pubblicato: true → ${TOPIC_OUT}`);
    await notifyAdmins(
        `🚪 Accesso ${azioneLog}`,
        `${tag.label} ha ${azioneLog.toLowerCase()} la porta`
    );
}

(async () => {
    try {
        await connectDB();
    } catch (err) {
        console.error("❌ Errore connessione MongoDB:", err.message);
        process.exit(1);
    }

    // Pubblica lo stato porta ogni 3 secondi su doormotic/stato/porta1
    // L'ESP32 lo riceve all'avvio e si sincronizza senza HTTP
    setInterval(async () => {
        try {
            const doc = await db.collection("door_state").findOne({ _id: "porta1" });
            const stato = doc ? doc.aperta : false;
            mqttClient.publish(TOPIC_STATO, stato ? "true" : "false");
        } catch (err) {
            console.error("❌ Errore publish stato periodico:", err.message);
        }
    }, 3000);

    mqttClient.on('message', async (topic, message) => {
        const payload = message.toString().trim();
        try {
            if (topic === TOPIC_IN) {
                await handleRfidMessage(payload);
            } else if (topic === TOPIC_STATO) {
                await handleStatoPorta(payload);
            }
        } catch (err) {
            console.error("❌ Errore handler:", err.message);
        }
    });

    console.log("\n══════════════════════════════════");
    console.log("  DOORmotic Worker avviato");
    console.log(`  Ascolto su:  ${TOPIC_IN}`);
    console.log(`  Risponde su: ${TOPIC_OUT}`);
    console.log(`  Stato su:    ${TOPIC_STATO}`);
    console.log("══════════════════════════════════\n");
})();