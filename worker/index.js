require('dotenv').config();
const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');

// ══════════════════════════════════════════════════════════════════
// TOPIC MQTT
//   IN  (ESP32 → broker → worker): doormotic/uid
//       payload: "UID;STATO"  es. "A08DD33E;0"
//       STATO: 1 = porta aperta, 0 = porta chiusa
//
//   OUT (worker → broker → ESP32): door/comandi/porta1
//       payload: "apri" | "chiudi" | "unauth"
// ══════════════════════════════════════════════════════════════════
const TOPIC_IN  = "doormotic/uid";
const TOPIC_OUT = "door/comandi/porta1";

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
        username:  tag.label,          // nome visibile nell'app
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
 * Payload atteso: "UID;STATO"
 *   UID   = stringa esadecimale del tag, es. "A08DD33E"
 *   STATO = "1" (porta aperta) | "0" (porta chiusa)
 */
async function handleRfidMessage(payload) {
    const parts = payload.split(";");
    if (parts.length < 2) {
        console.warn("⚠️  Payload malformato:", payload);
        return;
    }

    const uid          = parts[0].trim().toUpperCase();
    const statoAttuale = parts[1].trim(); // "1" o "0"

    console.log(`🏷️  Tag: ${uid} | Stato porta attuale: ${statoAttuale === "1" ? "Aperta" : "Chiusa"}`);

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
    // Se porta è chiusa (0) → manda "apri"
    // Se porta è aperta (1) → manda "chiudi"
    if (statoAttuale === "0") {
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
