#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>
#include <WiFi.h>

char ssid[] = "POCO M3 Pro 5G";
char pass[] = "96hdjzcvagh26yu";

const char* serverIP = "10.234.201.186";
int serverPort = 5000;

WiFiClient client;

// ---------------- RFID ----------------
#define SS_RFID 5
#define RST_PIN 9
#define SS_WIFI 10

MFRC522 mfrc522(SS_RFID, RST_PIN);

// ---------------- SERVO ----------------
Servo myservo;
int pos = 0;

// ---------------- UID ----------------
const String UID_CARTA = "87F29C31";
const String UID_TAG   = "A08DD33E";

// ---------------- CONTROL ----------------
bool cardHandled = false;

const int ledVerde = 2;
const int ledRosso = 4;
const int buzzer = 3;

// ------------------------------------------------

void setup() {
  Serial.begin(9600);
  SPI.begin();

  // SPI control
  pinMode(SS_WIFI, OUTPUT);
  pinMode(SS_RFID, OUTPUT);
  digitalWrite(SS_WIFI, HIGH);
  digitalWrite(SS_RFID, HIGH);

  // RFID init
  digitalWrite(SS_RFID, LOW);
  mfrc522.PCD_Init();
  digitalWrite(SS_RFID, HIGH);

  // LED + buzzer
  pinMode(ledVerde, OUTPUT);
  pinMode(ledRosso, OUTPUT);
  pinMode(buzzer, OUTPUT);

  // servo
  myservo.attach(6);
  myservo.write(pos);
  delay(500);
  myservo.detach();

  // WIFI
  Serial.println("Connessione WiFi...");
  WiFi.begin(ssid, pass);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi connesso!");
}

// ------------------------------------------------

void loop() {

  digitalWrite(SS_WIFI, HIGH);
  digitalWrite(SS_RFID, LOW);

  if (mfrc522.PICC_IsNewCardPresent()) {
    getID();
  } else {
    cardHandled = false;
  }

  Serial.println("CERCANDO...");
  delay(1000);
}

// ------------------------------------------------

void getID() {
  if (cardHandled) return;
  if (!mfrc522.PICC_ReadCardSerial()) return;

  String uidStr = "";

  for (byte i = 0; i < mfrc522.uid.size; i++) {
    uidStr += " ";
    if (mfrc522.uid.uidByte[i] < 0x10) uidStr += "0";
    uidStr += String(mfrc522.uid.uidByte[i], HEX);
  }

  Serial.print("UID tag:");
  Serial.println(uidStr);

  control(uidStr);

  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();

  cardHandled = true;
}

// ------------------------------------------------

void control(const String& rawUid) {

  String uid = "";
  for (char c : rawUid) if (c != ' ') uid += c;
  uid.toUpperCase();

  bool autorizzato = (uid == UID_CARTA) || (uid == UID_TAG);

  if (autorizzato) {

    digitalWrite(ledVerde, HIGH);
    tone(buzzer, 3500, 500);

    pos = (pos == 0) ? 90 : 0;

    myservo.attach(6);
    myservo.write(pos);
    delay(500);
    myservo.detach();

    inviaDatiAlServer(uid);

    digitalWrite(ledVerde, LOW);

  } else {

    digitalWrite(ledRosso, HIGH);
    tone(buzzer, 1000, 1000);
    delay(500);
    digitalWrite(ledRosso, LOW);
  }
}

// ------------------------------------------------

void inviaDatiAlServer(String idTag) {

  digitalWrite(SS_RFID, HIGH);
  digitalWrite(SS_WIFI, LOW);

  delay(100);

  if (client.connect(serverIP, serverPort)) {

    Serial.println("Invio a Flask...");

    String json = "{\"id\":\"" + idTag + "\"}";

    client.println("POST /nuovo_accesso HTTP/1.1");
    client.print("Host: "); client.println(serverIP);
    client.println("Content-Type: application/json");
    client.print("Content-Length: "); client.println(json.length());
    client.println();
    client.print(json);

    delay(10);
    client.stop();

    Serial.println("Dati inviati!");
  } else {
    Serial.println("Errore connessione server");
  }

  digitalWrite(SS_WIFI, HIGH);
  digitalWrite(SS_RFID, LOW);
}