require('dotenv').config();
const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');

// ══════════════════════════════════════════════════════════════════
// TOPIC MQTT
//   IN  (ESP32 → broker → worker): doormotic/uid
//       payload JSON: { "uid": "A08DD33E", "stato": true }
//       stato: true = porta aperta, false = porta chiusa
//
//   OUT (worker → broker → ESP32): doormotic/comandi/porta1
//       payload: "apri" | "chiudi" | "unauth"
// ══════════════════════════════════════════════════════════════════
const TOPIC_IN  = "doormotic/uid";
const TOPIC_OUT = "doormotic/comandi/porta1";

// ══════════════════════════════════════════════════════════════════
// MQTT
// ══════════════════════════════════════════════════════════════════
const mqttClient = mqtt.connect(`mqtts://${process.env.MQTT_BROKER}:${process.env.MQTT_PORT}`, {
    username:          process.env.MQTT_USER,
    password:          process.env.MQTT_PASSWORD,
    rejectUnauthorized: true,
    reconnectPeriod:   5000,
});

mqttClient.on('connect', () => {
    console.log("✅ MQTT connesso");
    mqttClient.subscribe(TOPIC_IN, (err) => {
        if (err) console.error("❌ Errore subscribe:", err.message);
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

/**
 * Cerca il tag nella collection "tags".
 * Se non esiste lo crea come "Sconosciuto" con accesso negato.
 * Restituisce il documento tag.
 */
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

/**
 * Salva il log nella collection "accesses" (stessa usata da Flask).
 */
async function saveLog(tag, azione) {
    const now = new Date();
    await db.collection("accesses").insertOne({
        username:  tag.label,
        tag_id:    tag.tag_id,
        orario:    now.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
        data:      now.toLocaleDateString("it-IT"),
        azione:    azione,             // "Aperta" | "Bloccata" | "Non autorizzato"
        source:    "RFID",
        timestamp: now
    });
}

// ══════════════════════════════════════════════════════════════════
// LOGICA PRINCIPALE — gestione messaggio RFID
// ══════════════════════════════════════════════════════════════════

/**
 * Payload atteso (JSON):
 *   { "uid": "A08DD33E", "stato": true }
 *   uid   = stringa esadecimale del tag, es. "A08DD33E"
 *   stato = true (porta aperta) | false (porta chiusa)
 */
async function handleRfidMessage(rawPayload) {
    let uid, statoAttuale;

    try {
        const parsed = JSON.parse(rawPayload);
        uid          = String(parsed.uid).trim().toUpperCase();
        statoAttuale = Boolean(parsed.stato); // true = aperta, false = chiusa
    } catch (e) {
        console.warn("⚠️  Payload malformato (JSON non valido):", rawPayload);
        return;
    }

    if (!uid) {
        console.warn("⚠️  Payload mancante del campo 'uid':", rawPayload);
        return;
    }

    console.log(`🏷️  Tag: ${uid} | Stato porta attuale: ${statoAttuale ? "Aperta" : "Chiusa"}`);

    const tag = await getOrCreateTag(uid);

    if (!tag.has_door_access) {
        // ── Accesso NEGATO ──────────────────────────────────────
        console.log(`🚫 Accesso negato per: ${tag.label} (${uid})`);
        await saveLog(tag, "Non autorizzato");
        mqttClient.publish(TOPIC_OUT, "unauth");
        console.log(`📤 Pubblicato: unauth → ${TOPIC_OUT}`);
        return;
    }

    // ── Accesso CONSENTITO: inverti lo stato ────────────────────
    // Se porta è chiusa (false) → manda "apri"
    // Se porta è aperta (true)  → manda "chiudi"

    if (statoAttuale) {
        await saveLog(tag, "Aperta");
        mqttClient.publish(TOPIC_OUT, "apri");
        console.log(`✅ ${tag.label} → Porta APERTA | Pubblicato: apri → ${TOPIC_OUT}`);
    } else {
        await saveLog(tag, "Bloccata");
        mqttClient.publish(TOPIC_OUT, "chiudi");
        console.log(`✅ ${tag.label} → Porta CHIUSA | Pubblicato: chiudi → ${TOPIC_OUT}`);
    }
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
        try {
            await handleRfidMessage(message.toString().trim());
        } catch (err) {
            console.error("❌ Errore handleRfidMessage:", err.message);
        }
    });

    console.log("\n══════════════════════════════════");
    console.log("  DOORmotic Worker avviato");
    console.log(`  Ascolto su:  ${TOPIC_IN}`);
    console.log(`  Comandi su:  ${TOPIC_OUT}`);
    console.log("══════════════════════════════════\n");
})();