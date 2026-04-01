import json
import re
import sqlite3
import unicodedata
from pathlib import Path

import xlrd


ROOT = Path(__file__).resolve().parents[2]
CUSTOMERS_XLS_PATH = Path(r"C:\Users\Hasan AY\Downloads\SATISCI.xls")
PRODUCTS_XLS_PATH = next(Path(r"C:\Users\Hasan AY\Downloads").glob("ÜRÜNLER.xls"))
DB_PATH = Path.home() / "AppData" / "Local" / "sales-order-system" / "sales-system-v2.sqlite"
BOOTSTRAP_JS_PATH = ROOT / "frontend" / "bootstrap.js"


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    normalized = normalized.lower().strip()
    normalized = re.sub(r"[^a-z0-9]+", ".", normalized)
    normalized = re.sub(r"\.+", ".", normalized).strip(".")
    return normalized or "user"


def clean_text(value) -> str:
    text = str(value).strip()
    if not text:
        return ""

    if any(marker in text for marker in ("Ã", "Ä", "Å", "Ð", "Þ")):
        for source_encoding in ("latin1", "cp1252"):
            try:
                text = text.encode(source_encoding).decode("utf-8")
                break
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue

    return " ".join(text.split())


def make_id(prefix: str, value: str) -> str:
    return f"{prefix}-{slugify(value)}"


def read_customer_rows():
    book = xlrd.open_workbook(str(CUSTOMERS_XLS_PATH))
    sheet = book.sheet_by_index(0)
    rows = []

    for row_index in range(1, sheet.nrows):
        customer_name = clean_text(sheet.cell_value(row_index, 0))
        city = clean_text(sheet.cell_value(row_index, 1))
        district = clean_text(sheet.cell_value(row_index, 2))
        rep_name = clean_text(sheet.cell_value(row_index, 3))

        if not customer_name or not rep_name:
            continue

        rows.append({
            "customer_name": customer_name,
            "city": city,
            "district": district,
            "rep_name": rep_name,
        })

    return rows


def read_product_rows():
    book = xlrd.open_workbook(str(PRODUCTS_XLS_PATH))
    sheet = book.sheet_by_index(0)
    rows = []

    for row_index in range(1, sheet.nrows):
        sku = clean_text(sheet.cell_value(row_index, 0))
        name = clean_text(sheet.cell_value(row_index, 1))
        if not sku or not name:
            continue
        rows.append({
            "id": make_id("product", sku),
            "sku": sku,
            "name": name,
            "unit": "adet",
        })

    return rows


def build_state(customer_rows, product_rows):
    company = {"id": "company-yemcibey", "name": "Yemcibey"}
    users = [{
        "id": "admin-1",
        "name": "Merkez Admin",
        "username": "admin",
        "password": "admin",
        "role": "admin",
        "companyId": company["id"],
        "region": "Tum Bolgeler",
    }]
    dealers = []
    customers = []
    seen_reps = {}
    seen_dealers = {}

    for row in customer_rows:
        rep_name = row["rep_name"]
        rep_id = seen_reps.get(rep_name)
        if not rep_id:
            username_base = slugify(rep_name)
            username = username_base
            suffix = 2
            existing_usernames = {user["username"] for user in users}
            while username in existing_usernames:
                username = f"{username_base}{suffix}"
                suffix += 1

            rep_id = make_id("rep", rep_name)
            seen_reps[rep_name] = rep_id
            users.append({
                "id": rep_id,
                "name": rep_name,
                "username": username,
                "password": "123456",
                "role": "sales",
                "companyId": company["id"],
                "region": row["city"] or "Belirtilmedi",
            })

        dealer_key = f'{row["city"]}::{row["district"]}::{rep_name}'
        dealer_id = seen_dealers.get(dealer_key)
        if not dealer_id:
            dealer_id = make_id("dealer", dealer_key)
            seen_dealers[dealer_key] = dealer_id
            location_name = " / ".join(filter(None, [row["city"], row["district"]])) or "Belirtilmedi"
            dealers.append({
                "id": dealer_id,
                "name": location_name,
                "companyId": company["id"],
                "repId": rep_id,
                "city": row["city"],
                "district": row["district"],
            })

        customers.append({
            "id": make_id("customer", f'{row["customer_name"]}-{row["city"]}-{row["district"]}-{rep_name}'),
            "name": row["customer_name"],
            "companyId": company["id"],
            "dealerId": dealer_id,
            "repId": rep_id,
            "city": row["city"],
            "district": row["district"],
        })

    return {
        "companies": [company],
        "users": users,
        "dealers": dealers,
        "customers": customers,
        "inventory": product_rows,
        "orders": [],
    }


def write_database(state):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode=OFF")
    cur.execute("PRAGMA synchronous=OFF")
    cur.execute("PRAGMA temp_store=MEMORY")
    cur.execute("PRAGMA foreign_keys=ON")

    cur.executescript(
        """
        CREATE TABLE companies (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL,
            company_id TEXT NOT NULL,
            region TEXT
        );
        CREATE TABLE dealers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            company_id TEXT NOT NULL,
            rep_id TEXT NOT NULL,
            city TEXT,
            district TEXT
        );
        CREATE TABLE customers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            company_id TEXT NOT NULL,
            dealer_id TEXT NOT NULL,
            rep_id TEXT NOT NULL,
            city TEXT,
            district TEXT
        );
        CREATE TABLE inventory (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sku TEXT UNIQUE NOT NULL,
            unit TEXT
        );
        CREATE TABLE orders (
            id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            rep_id TEXT NOT NULL,
            customer_id TEXT NOT NULL,
            delivery_date TEXT,
            payment_term TEXT,
            shipping_owner TEXT,
            note TEXT,
            review_status TEXT NOT NULL,
            submission_label TEXT NOT NULL,
            submitted_at TEXT,
            reviewed_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            revision_summary TEXT DEFAULT '[]'
        );
        CREATE TABLE order_items (
            id TEXT PRIMARY KEY,
            order_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
        """
    )

    cur.executemany("INSERT INTO companies VALUES (?, ?)", [
        (company["id"], company["name"]) for company in state["companies"]
    ])
    cur.executemany("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", [
        (
            user["id"], user["name"], user["username"], user["password"],
            user["role"], user["companyId"], user["region"]
        ) for user in state["users"]
    ])
    cur.executemany("INSERT INTO dealers VALUES (?, ?, ?, ?, ?, ?)", [
        (
            dealer["id"], dealer["name"], dealer["companyId"], dealer["repId"],
            dealer.get("city", ""), dealer.get("district", "")
        ) for dealer in state["dealers"]
    ])
    cur.executemany("INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?)", [
        (
            customer["id"], customer["name"], customer["companyId"], customer["dealerId"],
            customer["repId"], customer.get("city", ""), customer.get("district", "")
        ) for customer in state["customers"]
    ])
    cur.executemany("INSERT INTO inventory VALUES (?, ?, ?, ?)", [
        (item["id"], item["name"], item["sku"], item["unit"]) for item in state["inventory"]
    ])

    conn.commit()
    conn.close()


def write_bootstrap(state):
    users = [{k: v for k, v in user.items() if k != "password"} for user in state["users"]]
    payload = "window.BOOTSTRAP_STATE = " + json.dumps({**state, "users": users}, ensure_ascii=False, indent=2) + ";\n"
    BOOTSTRAP_JS_PATH.write_text(payload, encoding="utf-8")


def main():
    customer_rows = read_customer_rows()
    product_rows = read_product_rows()
    state = build_state(customer_rows, product_rows)
    write_database(state)
    write_bootstrap(state)
    print(json.dumps({
        "ok": True,
        "customers": len(state["customers"]),
        "salesReps": len(state["users"]) - 1,
        "products": len(state["inventory"]),
        "database": str(DB_PATH),
        "bootstrap": str(BOOTSTRAP_JS_PATH),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
