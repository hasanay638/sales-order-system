import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from scripts.db_gateway import DB_PATH, handle_action
from scripts.import_sales_data import rebuild_database


PORT = int(os.environ.get("PORT", "3000"))
ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT_DIR / "frontend"


def ensure_database():
    if not DB_PATH.exists():
        rebuild_database()


class PortalHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
      parsed = urlparse(self.path)
      if parsed.path == "/api/bootstrap":
          return self.handle_api({"action": "bootstrap"})
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
