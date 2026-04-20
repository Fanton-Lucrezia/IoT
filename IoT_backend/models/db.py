import mysql.connector
from config import DB_CONFIG
from dotenv import load_dotenv

load_dotenv()
def get_db():
    return mysql.connector.connect(**DB_CONFIG)