import json
import sys
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

from db_gateway import connect


def normalize_text(value):
    replacements = str.maketrans({
        "ı": "i",
        "İ": "I",
        "ş": "s",
        "Ş": "S",
        "ğ": "g",
        "Ğ": "G",
        "ü": "u",
        "Ü": "U",
        "ö": "o",
        "Ö": "O",
        "ç": "c",
        "Ç": "C",
    })
    text = str(value or "").translate(replacements)
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    return " ".join(text.replace("_", " ").replace("-", " ").split())


def parse_xml(path):
    root = ET.parse(path).getroot()
    order = root.find("ORDER_SLIP")
    lines = []
    for transaction in order.find("TRANSACTIONS").findall("TRANSACTION"):
        lines.append({
            "masterCode": get_text(transaction, "MASTER_CODE"),
            "quantity": get_text(transaction, "QUANTITY"),
            "price": get_text(transaction, "PRICE"),
            "total": get_text(transaction, "TOTAL"),
            "vatRate": get_text(transaction, "VAT_RATE"),
            "vatAmount": get_text(transaction, "VAT_AMOUNT"),
            "unitCode": get_text(transaction, "UNIT_CODE"),
            "dueDate": get_text(transaction, "DUE_DATE"),
            "auxilCode": get_text(transaction, "AUXIL_CODE"),
            "internalReference": get_text(transaction, "INTERNAL_REFERENCE"),
        })

    return {
        "fileName": path.name,
        "number": get_text(order, "NUMBER"),
        "date": get_text(order, "DATE"),
        "arpCode": get_text(order, "ARP_CODE"),
        "salesmanCode": get_text(order, "SALESMAN_CODE"),
        "paymentCode": get_text(order, "PAYMENT_CODE"),
        "paydefRef": get_text(order, "PAYDEFREF"),
        "docTrackNr": get_text(order, "DOC_TRACK_NR"),
        "totalDiscounted": get_text(order, "TOTAL_DISCOUNTED"),
        "totalVat": get_text(order, "TOTAL_VAT"),
        "totalGross": get_text(order, "TOTAL_GROSS"),
        "totalNet": get_text(order, "TOTAL_NET"),
        "rcRate": get_text(order, "RC_RATE"),
        "rcNet": get_text(order, "RC_NET"),
        "notes": [get_text(order, "NOTES1"), get_text(order, "NOTES2"), get_text(order, "NOTES3"), get_text(order, "NOTES4")],
        "itext": get_text(order, "ITEXT"),
        "sourceWh": get_text(order, "SOURCE_WH"),
        "sourceCostGrp": get_text(order, "SOURCE_COST_GRP"),
        "factory": get_text(order, "FACTORY"),
        "division": get_text(order, "DIVISION"),
        "orderStatus": get_text(order, "ORDER_STATUS"),
        "internalReference": get_text(order, "INTERNAL_REFERENCE"),
        "guid": get_text(order, "GUID"),
        "lines": lines,
    }


def get_text(node, tag):
    child = node.find(tag)
    return (child.text or "").strip() if child is not None and child.text is not None else ""


def load_reference_data(conn):
    conn.row_factory = None
    customers = []
    for row in conn.execute("SELECT id, name, rep_id, city, district, COALESCE(erp_code, '') FROM customers"):
        customers.append({
            "id": row[0],
            "name": row[1],
            "repId": row[2],
            "city": row[3],
            "district": row[4],
            "erpCode": row[5],
        })

    users = []
    for row in conn.execute("SELECT id, name, username, COALESCE(salesman_code, '') FROM users WHERE role = 'sales'"):
        users.append({
            "id": row[0],
            "name": row[1],
            "username": row[2],
            "salesmanCode": row[3],
        })

    inventory = []
    for row in conn.execute("SELECT id, name, sku, unit FROM inventory"):
        inventory.append({
            "id": row[0],
            "name": row[1],
            "sku": row[2],
            "unit": row[3],
        })

    return customers, users, inventory


def match_customer(order, customers):
    exact = next((customer for customer in customers if customer["erpCode"] and customer["erpCode"] == order["arpCode"]), None)
    if exact:
        return {"match": exact, "method": "erpCode", "warning": ""}

    stem = normalize_text(Path(order["fileName"]).stem)
    city_hint = normalize_text(order["notes"][0].replace("SEVK YERI", "").replace("SEVK YERİ", ""))
    candidates = []
    stem_tokens = [token for token in stem.split() if len(token) > 2 and token != "siparis"]
    for customer in customers:
        customer_name = normalize_text(customer["name"])
        customer_location = normalize_text(f'{customer["city"]} {customer["district"]}')
        token_matches = [token for token in stem_tokens if token in customer_name]
        if token_matches:
            score = len(token_matches)
            if city_hint and any(part in city_hint for part in customer_location.split() if part):
                score += 1
            candidates.append((score, customer))

    candidates.sort(key=lambda item: item[0], reverse=True)
    if candidates:
        return {
            "match": candidates[0][1],
            "method": "fileNameHeuristic",
            "warning": "Musteri eslesmesi ERP kodu ile degil dosya adindan sezgisel yapildi.",
        }

    return {"match": None, "method": "none", "warning": "Musteri eslesmesi bulunamadi."}


def match_salesman(order, users):
    exact = next((user for user in users if user["salesmanCode"] == order["salesmanCode"]), None)
    if exact:
        return exact
    return None


def analyze_order(order, customers, users, inventory):
    customer_result = match_customer(order, customers)
    salesman_match = match_salesman(order, users)
    inventory_by_sku = {item["sku"]: item for item in inventory}

    line_results = []
    unsupported_lines = []
    for line in order["lines"]:
        product = inventory_by_sku.get(line["masterCode"])
        if not product:
            unsupported_lines.append(line["masterCode"])
        line_results.append({
            "masterCode": line["masterCode"],
            "matchedProductId": product["id"] if product else "",
            "matchedProductName": product["name"] if product else "",
            "unitCode": line["unitCode"],
            "vatRate": line["vatRate"],
            "vatAmount": line["vatAmount"],
            "auxilCode": line["auxilCode"],
        })

    missing_model_fields = [
        {
            "field": "Customer ERP code (ARP_CODE)",
            "status": "missing_in_current_data" if not customer_result["match"] or not customer_result["match"].get("erpCode") else "available",
            "recommendedLocation": "customers.erp_code + admin customer form/assignment form",
        },
        {
            "field": "Salesman short code (SALESMAN_CODE)",
            "status": "available" if salesman_match else "missing_in_current_data",
            "recommendedLocation": "users.salesman_code + admin sales rep form/list",
        },
        {
            "field": "Order ERP metadata (NUMBER, DOC_TRACK_NR, TOTAL_*, RC_*, FACTORY, DIVISION, GUID, INTERNAL_REFERENCE)",
            "status": "missing_in_model",
            "recommendedLocation": "orders.erp_* columns and orders.erp_payload JSON",
        },
        {
            "field": "Line ERP metadata (VAT_*, UNIT_CODE, DUE_DATE, AUXIL_CODE, INTERNAL_REFERENCE)",
            "status": "missing_in_model",
            "recommendedLocation": "order_items.erp_payload JSON and optional typed columns",
        },
        {
            "field": "Service/freight line support",
            "status": "missing_in_data" if unsupported_lines else "available",
            "recommendedLocation": "inventory as service SKU or order_items line_type/category",
        },
    ]

    return {
        "fileName": order["fileName"],
        "orderNumber": order["number"],
        "arpCode": order["arpCode"],
        "matchedCustomer": customer_result["match"],
        "customerMatchMethod": customer_result["method"],
        "customerWarning": customer_result["warning"],
        "matchedSalesman": salesman_match,
        "salesmanMismatch": bool(customer_result["match"] and salesman_match and customer_result["match"]["repId"] != salesman_match["id"]),
        "lineResults": line_results,
        "unsupportedLineCodes": unsupported_lines,
        "missingModelFields": missing_model_fields,
    }


def main(args):
    if not args:
        raise SystemExit("XML dosya yolu verin.")

    paths = [Path(arg) for arg in args]
    conn = connect()
    try:
        customers, users, inventory = load_reference_data(conn)
        report = [analyze_order(parse_xml(path), customers, users, inventory) for path in paths]
    finally:
        conn.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main(sys.argv[1:])
