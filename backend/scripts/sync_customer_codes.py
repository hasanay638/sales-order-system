import json
import sqlite3

try:
    from scripts.import_sales_data import CUSTOMER_CODES_XLS_PATH, DB_PATH, normalize_key, read_customer_code_rows
except ModuleNotFoundError:
    from import_sales_data import CUSTOMER_CODES_XLS_PATH, DB_PATH, normalize_key, read_customer_code_rows


def sync_customer_codes():
    code_rows = read_customer_code_rows()
    code_map = {row["normalizedName"]: row["erpCode"] for row in code_rows}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        customers = conn.execute("SELECT id, name, COALESCE(erp_code, '') AS erp_code FROM customers").fetchall()
        matched = 0
        unchanged = 0
        missing = []

        for customer in customers:
            erp_code = code_map.get(normalize_key(customer["name"]), "")
            if not erp_code:
                missing.append(customer["name"])
                continue
            if customer["erp_code"] == erp_code:
                unchanged += 1
                continue
            conn.execute("UPDATE customers SET erp_code = ? WHERE id = ?", (erp_code, customer["id"]))
            matched += 1

        conn.commit()
        return {
            "ok": True,
            "source": str(CUSTOMER_CODES_XLS_PATH),
            "matched": matched,
            "unchanged": unchanged,
            "missing": len(missing),
            "missingCustomers": missing[:25],
        }
    finally:
        conn.close()


def main():
    print(json.dumps(sync_customer_codes(), ensure_ascii=False))


if __name__ == "__main__":
    main()
