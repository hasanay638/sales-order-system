import json
import mimetypes
import os
import re
import unicodedata
from html import escape
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from scripts.db_gateway import DB_PATH, connect, build_order_snapshot, format_order_date, get_shipping_label, handle_action
from scripts.import_sales_data import rebuild_database


PORT = int(os.environ.get("PORT", "3000"))
ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"


def ensure_database():
    if not DB_PATH.exists():
        rebuild_database()


def make_export_filename(customer_name, order_number):
    words = [word for word in re.split(r"\s+", str(customer_name or "").strip()) if word][:4]
    base = " ".join(words) or "siparis"
    normalized = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode("ascii")
    normalized = re.sub(r"[^A-Za-z0-9]+", "-", normalized).strip("-").lower() or "siparis"
    return f"{normalized}-{order_number or 'no'}.xls"


def build_order_excel_html(order):
    items = order.get("items", [])
    erp = order.get("erpPayload") or {}
    shared_fields = [
        ("DBOP", erp.get("DBOP")),
        ("SOURCE_WH", erp.get("SOURCE_WH")),
        ("SOURCE_COST_GRP", erp.get("SOURCE_COST_GRP")),
        ("DIVISION", erp.get("DIVISION")),
        ("ORDER_STATUS", erp.get("ORDER_STATUS")),
        ("CREATED_BY", erp.get("CREATED_BY")),
        ("MODIFIED_BY", erp.get("MODIFIED_BY")),
        ("CURRSEL_TOTAL", erp.get("CURRSEL_TOTAL")),
        ("FACTORY", erp.get("FACTORY")),
        ("PROJECT_CODE", erp.get("PROJECT_CODE")),
        ("AFFECT_RISK", erp.get("AFFECT_RISK")),
        ("DEDUCTIONPART1", erp.get("DEDUCTIONPART1")),
        ("DEDUCTIONPART2", erp.get("DEDUCTIONPART2")),
        ("EINVOICE_PROFILEID", erp.get("EINVOICE_PROFILEID")),
        ("CANT_CRE_DEDUCT", erp.get("CANT_CRE_DEDUCT")),
    ]
    item_rows = []
    for index, item in enumerate(items, start=1):
        item_erp = item.get("erpPayload") or {}
        item_rows.append(f"""
          <tr>
            <td>{index}</td>
            <td>{escape(str(item_erp.get("MASTER_CODE") or item.get("sku") or ""))}</td>
            <td>{escape(str(item.get("productName") or item_erp.get("PRODUCT_NAME") or "-"))}</td>
            <td>{escape(str(item_erp.get("UNIT_CODE") or "ÇUVAL"))}</td>
            <td>{escape(str(item.get("quantity") or 0))}</td>
            <td>{escape(str(item_erp.get("BAG_KG") or 50))}</td>
            <td>{escape(str(item_erp.get("TOTAL_KG") or 0))}</td>
            <td>{escape(str(item.get("price") or 0))}</td>
            <td>{escape(str(item_erp.get("TOTAL") or 0))}</td>
            <td>{escape(str(item_erp.get("DUE_DATE") or format_order_date(order.get("deliveryDate")) or "-"))}</td>
            <td>{escape(str(item_erp.get("TYPE") or "-"))}</td>
            <td>{escape(str(item_erp.get("PROJECT_CODE") or "-"))}</td>
          </tr>
        """)

    note_lines = [erp.get("NOTES1"), erp.get("NOTES2"), erp.get("NOTES3"), erp.get("NOTES4"), order.get("note")]
    note_markup = "<br>".join(escape(str(note)) for note in note_lines if note)
    shared_rows = "".join(
        f"<tr><td class=\"label\">{escape(label)}</td><td>{escape(str(value if value not in (None, '') else '-'))}</td></tr>"
        for label, value in shared_fields
    )
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }}
    h1 {{ margin: 0 0 16px; font-size: 22px; }}
    .meta {{ width: 100%; border-collapse: collapse; margin-bottom: 18px; }}
    .meta td {{ border: 1px solid #cbd5e1; padding: 8px 10px; vertical-align: top; }}
    .meta .label {{ width: 180px; font-weight: 700; background: #eff6ff; }}
    .lines {{ width: 100%; border-collapse: collapse; }}
    .lines th, .lines td {{ border: 1px solid #cbd5e1; padding: 8px 10px; }}
    .lines th {{ background: #dbeafe; text-align: left; }}
    .section {{ margin: 18px 0 8px; font-size: 16px; font-weight: 700; }}
  </style>
</head>
<body>
  <h1>Siparis Ciktisi</h1>
  <table class="meta">
    <tr><td class="label">Siparis No</td><td>#{escape(str(order.get("orderNumber") or "-"))}</td><td class="label">ERP Siparis No</td><td>{escape(str(erp.get("NUMBER") or order.get("erpOrderNumber") or "-"))}</td></tr>
    <tr><td class="label">Musteri</td><td>{escape(str(order.get("customerName") or "-"))}</td><td class="label">ERP Musteri Kodu</td><td>{escape(str(erp.get("ARP_CODE") or order.get("customerErpCode") or "-"))}</td></tr>
    <tr><td class="label">Satici</td><td>{escape(str(order.get("repName") or "-"))}</td><td class="label">Satisci Kodu</td><td>{escape(str(erp.get("SALESMAN_CODE") or "-"))}</td></tr>
    <tr><td class="label">Firma</td><td>{escape(str(order.get("companyName") or "-"))}</td><td class="label">Bayi</td><td>{escape(str(erp.get("DEALER_NAME") or "-"))}</td></tr>
    <tr><td class="label">Siparis Tarihi</td><td>{escape(str(format_order_date(erp.get("DATE") or order.get("submittedAt")) or "-"))}</td><td class="label">Teslim Tarihi</td><td>{escape(str(format_order_date(order.get("deliveryDate")) or "-"))}</td></tr>
    <tr><td class="label">Vade</td><td>{escape(str(order.get("paymentTerm") or "-"))}</td><td class="label">Nakliye</td><td>{escape(str(get_shipping_label(order.get("shippingOwner")) or "-"))}</td></tr>
    <tr><td class="label">Toplam Tutar</td><td>{escape(str(order.get("totalAmount") or 0))}</td><td class="label">Toplam Kg</td><td>{escape(str(order.get("totalKg") or 0))}</td></tr>
    <tr><td class="label">Belge Takip No</td><td>{escape(str(erp.get("DOC_TRACK_NR") or "-"))}</td><td class="label">Siparis Durumu</td><td>{escape(str(order.get("submissionLabel") or "-"))}</td></tr>
    <tr><td class="label">Notlar</td><td colspan="3">{note_markup or "-"}</td></tr>
  </table>

  <div class="section">Urun Satirlari</div>
  <table class="lines">
    <thead>
      <tr>
        <th>Sira</th>
        <th>Stok Kodu</th>
        <th>Urun</th>
        <th>Birim</th>
        <th>Miktar</th>
        <th>Cuval Kg</th>
        <th>Toplam Kg</th>
        <th>Fiyat</th>
        <th>Toplam</th>
        <th>Vade Tarihi</th>
        <th>Type</th>
        <th>Project Code</th>
      </tr>
    </thead>
    <tbody>
      {''.join(item_rows) or '<tr><td colspan="12">Urun kalemi yok.</td></tr>'}
    </tbody>
  </table>

  <div class="section">Ortak ERP Alanlari</div>
  <table class="meta">
    {shared_rows}
  </table>
</body>
</html>"""


class PortalHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
      parsed = urlparse(self.path)
      if parsed.path == "/api/bootstrap":
          return self.handle_api({"action": "bootstrap"})
      export_match = re.fullmatch(r"/api/orders/([^/]+)/export", parsed.path)
      if export_match:
          return self.export_order_excel(export_match.group(1))
      sales_rep_match = re.fullmatch(r"/api/sales-reps/([^/]+)", parsed.path)
      if sales_rep_match:
          return self.handle_api({"action": "get_sales_rep", "repId": sales_rep_match.group(1)})

      return self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/login":
            return self.handle_api({**self.read_json_body(), "action": "login"}, status=HTTPStatus.OK, error_status=HTTPStatus.UNAUTHORIZED)
        if parsed.path == "/api/customers":
            return self.handle_api({**self.read_json_body(), "action": "create_customer"})
        if parsed.path == "/api/customers/bulk-transfer":
            return self.handle_api({**self.read_json_body(), "action": "bulk_transfer_customers"})
        if parsed.path == "/api/customer-codes/import":
            return self.handle_api({"action": "import_customer_codes"})
        if parsed.path == "/api/sales-reps":
            return self.handle_api({**self.read_json_body(), "action": "create_sales_rep"})
        if parsed.path == "/api/products":
            return self.handle_api({**self.read_json_body(), "action": "create_product"})
        restore_match = re.fullmatch(r"/api/deleted-records/([^/]+)/restore", parsed.path)
        if restore_match:
            return self.handle_api({"action": "restore_deleted_record", "deletedRecordId": restore_match.group(1)})
        if parsed.path == "/api/orders":
            body = self.read_json_body()
            return self.handle_api({**body, "action": "create_order", "now": self.now_iso()})
        if parsed.path == "/api/reset":
            try:
                result = rebuild_database()
                return self.send_json(result)
            except Exception as exc:
                return self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

        approve_match = re.fullmatch(r"/api/orders/([^/]+)/approve", parsed.path)
        if approve_match:
            return self.handle_api({"action": "approve_order", "orderId": approve_match.group(1), "now": self.now_iso()})

        reject_match = re.fullmatch(r"/api/orders/([^/]+)/reject", parsed.path)
        if reject_match:
            return self.handle_api({"action": "reject_order", "orderId": reject_match.group(1), "now": self.now_iso()})

        return self.send_error_json(HTTPStatus.NOT_FOUND, "Kaynak bulunamadi.")

    def do_PUT(self):
        parsed = urlparse(self.path)
        assignment_match = re.fullmatch(r"/api/customers/([^/]+)/assignment", parsed.path)
        if assignment_match:
            body = self.read_json_body()
            return self.handle_api({**body, "action": "update_customer_assignment", "customerId": assignment_match.group(1)})
        sales_rep_match = re.fullmatch(r"/api/sales-reps/([^/]+)", parsed.path)
        if sales_rep_match:
            body = self.read_json_body()
            return self.handle_api({**body, "action": "update_sales_rep", "repId": sales_rep_match.group(1)})

        order_match = re.fullmatch(r"/api/orders/([^/]+)", parsed.path)
        if order_match:
            body = self.read_json_body()
            return self.handle_api({**body, "action": "update_order", "orderId": order_match.group(1), "now": self.now_iso()})

        return self.send_error_json(HTTPStatus.NOT_FOUND, "Kaynak bulunamadi.")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        deleted_by_id = self.headers.get("X-User-Id", "")
        deleted_by_name = self.headers.get("X-User-Name", "")

        customer_match = re.fullmatch(r"/api/customers/([^/]+)", parsed.path)
        if customer_match:
            return self.handle_api({"action": "delete_customer", "customerId": customer_match.group(1), "now": self.now_iso(), "deletedById": deleted_by_id, "deletedByName": deleted_by_name})

        rep_match = re.fullmatch(r"/api/sales-reps/([^/]+)", parsed.path)
        if rep_match:
            return self.handle_api({"action": "delete_sales_rep", "repId": rep_match.group(1), "now": self.now_iso(), "deletedById": deleted_by_id, "deletedByName": deleted_by_name})

        product_match = re.fullmatch(r"/api/products/([^/]+)", parsed.path)
        if product_match:
            return self.handle_api({"action": "delete_product", "productId": product_match.group(1), "now": self.now_iso(), "deletedById": deleted_by_id, "deletedByName": deleted_by_name})

        order_match = re.fullmatch(r"/api/orders/([^/]+)", parsed.path)
        if order_match:
            return self.handle_api({"action": "delete_order", "orderId": order_match.group(1), "now": self.now_iso(), "deletedById": deleted_by_id, "deletedByName": deleted_by_name})

        return self.send_error_json(HTTPStatus.NOT_FOUND, "Kaynak bulunamadi.")

    def serve_static(self, request_path):
        safe_path = request_path.lstrip("/") or "index.html"
        candidate = (FRONTEND_DIR / safe_path).resolve()
        if candidate.is_file() and FRONTEND_DIR in candidate.parents:
            return self.send_file(candidate)
        return self.send_file(FRONTEND_DIR / "index.html")

    def send_file(self, path):
        content = path.read_bytes()
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def export_order_excel(self, order_id):
        conn = connect()
        try:
            order = build_order_snapshot(conn, order_id)
        finally:
            conn.close()

        if not order:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "Siparis bulunamadi.")

        if order.get("reviewStatus") != "reviewed":
            return self.send_error_json(HTTPStatus.BAD_REQUEST, "Excel ciktisi sadece onaylanan siparisler icin alinabilir.")

        filename = make_export_filename(order.get("customerName"), order.get("orderNumber"))
        content = build_order_excel_html(order).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/vnd.ms-excel; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        return json.loads(body.decode("utf-8") or "{}")

    def handle_api(self, payload, status=HTTPStatus.OK, error_status=HTTPStatus.BAD_REQUEST):
        try:
            result = handle_action(payload)
            return self.send_json(result, status=status)
        except Exception as exc:
            return self.send_error_json(error_status if status == HTTPStatus.OK else status, str(exc))

    def send_json(self, payload, status=HTTPStatus.OK):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_json(self, status, message):
        self.send_json({"message": message or "Sunucu hatasi."}, status=status)

    def log_message(self, format, *args):
        return

    @staticmethod
    def now_iso():
        from datetime import datetime
        return datetime.now().astimezone().isoformat()


if __name__ == "__main__":
    ensure_database()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), PortalHandler)
    print(f"Portal hazir: http://localhost:{PORT}")
    server.serve_forever()
