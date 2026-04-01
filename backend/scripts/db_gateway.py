import json
import os
import re
import sqlite3
import sys
import unicodedata
import uuid
from pathlib import Path

try:
    from scripts.sync_customer_codes import sync_customer_codes
except ModuleNotFoundError:
    from sync_customer_codes import sync_customer_codes

DB_ROOT = Path(
    os.environ.get(
        "TEMP",
        os.environ.get("LOCALAPPDATA", str(Path(__file__).resolve().parents[2] / 'backend' / 'data'))
    )
) / 'sales-order-system'
DB_PATH = DB_ROOT / 'sales-system-v2.sqlite'


def build_salesman_code(name):
    normalized = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode("ascii")
    parts = [part for part in re.split(r"[^A-Za-z0-9]+", normalized.upper()) if part]
    if not parts:
        return ""
    return f"{parts[0][0]}.{parts[-1]}"


def ensure_schema(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS deleted_records (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            payload TEXT NOT NULL,
            deleted_by_id TEXT,
            deleted_by_name TEXT,
            deleted_at TEXT NOT NULL
        )
    """)
    migrations = {
        'users': {
            'salesman_code': "ALTER TABLE users ADD COLUMN salesman_code TEXT",
        },
        'customers': {
            'erp_code': "ALTER TABLE customers ADD COLUMN erp_code TEXT",
        },
        'orders': {
            'order_number': "ALTER TABLE orders ADD COLUMN order_number INTEGER",
            'erp_order_number': "ALTER TABLE orders ADD COLUMN erp_order_number TEXT",
            'erp_doc_track_nr': "ALTER TABLE orders ADD COLUMN erp_doc_track_nr TEXT",
            'erp_customer_code': "ALTER TABLE orders ADD COLUMN erp_customer_code TEXT",
            'erp_order_date': "ALTER TABLE orders ADD COLUMN erp_order_date TEXT",
            'erp_payload': "ALTER TABLE orders ADD COLUMN erp_payload TEXT DEFAULT '{}'",
        },
        'order_items': {
            'erp_line_ref': "ALTER TABLE order_items ADD COLUMN erp_line_ref TEXT",
            'erp_payload': "ALTER TABLE order_items ADD COLUMN erp_payload TEXT DEFAULT '{}'",
        },
    }

    deleted_columns = {row[1] for row in conn.execute('PRAGMA table_info(deleted_records)').fetchall()}
    if 'deleted_by_id' not in deleted_columns:
        conn.execute("ALTER TABLE deleted_records ADD COLUMN deleted_by_id TEXT")
    if 'deleted_by_name' not in deleted_columns:
        conn.execute("ALTER TABLE deleted_records ADD COLUMN deleted_by_name TEXT")

    for table_name, table_migrations in migrations.items():
        columns = {row[1] for row in conn.execute(f'PRAGMA table_info({table_name})').fetchall()}
        for column_name, statement in table_migrations.items():
            if column_name not in columns:
                conn.execute(statement)

    missing_codes = conn.execute(
        "SELECT id, name FROM users WHERE role = 'sales' AND (salesman_code IS NULL OR salesman_code = '')"
    ).fetchall()
    for row in missing_codes:
        conn.execute('UPDATE users SET salesman_code = ? WHERE id = ?', (build_salesman_code(row['name']), row['id']))

    missing_order_numbers = conn.execute(
        "SELECT id FROM orders WHERE order_number IS NULL ORDER BY datetime(coalesce(created_at, submitted_at, updated_at)), rowid"
    ).fetchall()
    next_number = conn.execute("SELECT COALESCE(MAX(order_number), 0) + 1 FROM orders").fetchone()[0]
    for row in missing_order_numbers:
        conn.execute('UPDATE orders SET order_number = ? WHERE id = ?', (next_number, row['id']))
        next_number += 1

    sequence_row = conn.execute("SELECT value FROM app_meta WHERE key = 'order_sequence'").fetchone()
    current_max = conn.execute("SELECT COALESCE(MAX(order_number), 0) FROM orders").fetchone()[0]
    if sequence_row is None:
        conn.execute("INSERT INTO app_meta (key, value) VALUES ('order_sequence', ?)", (str(current_max),))
    elif int(sequence_row[0]) < current_max:
        conn.execute("UPDATE app_meta SET value = ? WHERE key = 'order_sequence'", (str(current_max),))

    conn.commit()


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def make_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def rows_to_dicts(rows):
    return [dict(row) for row in rows]


def get_next_order_number(conn):
    current_value = int(conn.execute("SELECT value FROM app_meta WHERE key = 'order_sequence'").fetchone()[0])
    next_value = current_value + 1
    conn.execute("UPDATE app_meta SET value = ? WHERE key = 'order_sequence'", (str(next_value),))
    return next_value


def get_orders(conn):
    orders = rows_to_dicts(conn.execute('''
        SELECT id, company_id as companyId, rep_id as repId, customer_id as customerId,
               delivery_date as deliveryDate, payment_term as paymentTerm,
               shipping_owner as shippingOwner, note, review_status as reviewStatus,
               submission_label as submissionLabel, submitted_at as submittedAt,
               reviewed_at as reviewedAt, created_at as createdAt, updated_at as updatedAt,
               revision_summary as revisionSummary, order_number as orderNumber
        FROM orders
        ORDER BY datetime(coalesce(submitted_at, updated_at, created_at)) DESC
    ''').fetchall())
    for order in orders:
        order['revisionSummary'] = json.loads(order.get('revisionSummary') or '[]')
        order['items'] = rows_to_dicts(conn.execute('''
            SELECT id, order_id as orderId, product_id as productId, quantity, price
            FROM order_items WHERE order_id = ? ORDER BY rowid ASC
        ''', (order['id'],)).fetchall())
    return orders


def get_deleted_records(conn):
    records = rows_to_dicts(conn.execute('''
        SELECT id, entity_type as entityType, entity_id as entityId, display_name as displayName,
               payload, deleted_by_id as deletedById, deleted_by_name as deletedByName, deleted_at as deletedAt
        FROM deleted_records
        ORDER BY datetime(deleted_at) DESC, rowid DESC
    ''').fetchall())
    for record in records:
        record['payload'] = json.loads(record.get('payload') or '{}')
    return records


def get_bootstrap(conn):
    return {
        'companies': rows_to_dicts(conn.execute('SELECT id, name FROM companies ORDER BY name').fetchall()),
        'users': rows_to_dicts(conn.execute('''
            SELECT id, name, username, role, company_id as companyId, region, salesman_code as salesmanCode
            FROM users ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END, name
        ''').fetchall()),
        'dealers': rows_to_dicts(conn.execute('''
            SELECT id, name, company_id as companyId, rep_id as repId, city, district
            FROM dealers ORDER BY name
        ''').fetchall()),
        'customers': rows_to_dicts(conn.execute('''
            SELECT id, name, company_id as companyId, dealer_id as dealerId, rep_id as repId, city, district, erp_code as erpCode
            FROM customers ORDER BY name
        ''').fetchall()),
        'inventory': rows_to_dicts(conn.execute('SELECT id, name, sku, unit FROM inventory ORDER BY name').fetchall()),
        'orders': get_orders(conn),
        'deletedRecords': get_deleted_records(conn)
    }


def slugify(value):
    value = ''.join(character.lower() if character.isalnum() else '.' for character in str(value).strip())
    while '..' in value:
        value = value.replace('..', '.')
    return value.strip('.') or 'user'


def replace_order_items(conn, order_id, items):
    conn.execute('DELETE FROM order_items WHERE order_id = ?', (order_id,))
    for item in items:
        conn.execute('''
            INSERT INTO order_items (id, order_id, product_id, quantity, price)
            VALUES (?, ?, ?, ?, ?)
        ''', (item.get('id') or make_id('line'), order_id, item['productId'], item['quantity'], item['price']))


def archive_record(conn, entity_type, entity_id, display_name, payload, deleted_at, deleted_by_id='', deleted_by_name=''):
    conn.execute('''
        INSERT INTO deleted_records (id, entity_type, entity_id, display_name, payload, deleted_by_id, deleted_by_name, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        make_id('deleted'),
        entity_type,
        entity_id,
        display_name,
        json.dumps(payload, ensure_ascii=False),
        deleted_by_id,
        deleted_by_name,
        deleted_at
    ))


def build_order_snapshot(conn, order_id):
    order = conn.execute('''
        SELECT id, order_number, company_id, rep_id, customer_id, delivery_date, payment_term, shipping_owner,
               note, review_status, submission_label, submitted_at, reviewed_at, created_at, updated_at, revision_summary
        FROM orders WHERE id = ?
    ''', (order_id,)).fetchone()
    if not order:
        return None

    customer = conn.execute('SELECT name, erp_code FROM customers WHERE id = ?', (order['customer_id'],)).fetchone()
    rep = conn.execute('SELECT name, username, region FROM users WHERE id = ?', (order['rep_id'],)).fetchone()
    company = conn.execute('SELECT name FROM companies WHERE id = ?', (order['company_id'],)).fetchone()
    items = rows_to_dicts(conn.execute('''
        SELECT oi.id, oi.product_id as productId, oi.quantity, oi.price, i.name as productName, i.sku, i.unit
        FROM order_items oi
        LEFT JOIN inventory i ON i.id = oi.product_id
        WHERE oi.order_id = ?
        ORDER BY oi.rowid ASC
    ''', (order_id,)).fetchall())

    return {
        'id': order['id'],
        'orderNumber': order['order_number'],
        'companyId': order['company_id'],
        'companyName': company['name'] if company else '-',
        'repId': order['rep_id'],
        'repName': rep['name'] if rep else '-',
        'repUsername': rep['username'] if rep else '',
        'repRegion': rep['region'] if rep else '',
        'customerId': order['customer_id'],
        'customerName': customer['name'] if customer else '-',
        'customerErpCode': customer['erp_code'] if customer else '',
        'deliveryDate': order['delivery_date'],
        'paymentTerm': order['payment_term'],
        'shippingOwner': order['shipping_owner'],
        'note': order['note'],
        'reviewStatus': order['review_status'],
        'submissionLabel': order['submission_label'],
        'submittedAt': order['submitted_at'],
        'reviewedAt': order['reviewed_at'],
        'createdAt': order['created_at'],
        'updatedAt': order['updated_at'],
        'revisionSummary': json.loads(order['revision_summary'] or '[]'),
        'totalAmount': sum(float(item['quantity']) * float(item['price']) for item in items),
        'totalKg': sum(float(item['quantity']) * 50 for item in items),
        'items': items
    }


def build_customer_snapshot(conn, customer_id):
    row = conn.execute('''
        SELECT c.id, c.name, c.erp_code, c.city, c.district,
               co.name as company_name, d.name as dealer_name, u.name as rep_name, u.username as rep_username
        FROM customers c
        LEFT JOIN companies co ON co.id = c.company_id
        LEFT JOIN dealers d ON d.id = c.dealer_id
        LEFT JOIN users u ON u.id = c.rep_id
        WHERE c.id = ?
    ''', (customer_id,)).fetchone()
    if not row:
        return None

    return {
        'id': row['id'],
        'name': row['name'],
        'companyId': conn.execute('SELECT company_id FROM customers WHERE id = ?', (customer_id,)).fetchone()[0],
        'dealerId': conn.execute('SELECT dealer_id FROM customers WHERE id = ?', (customer_id,)).fetchone()[0],
        'repId': conn.execute('SELECT rep_id FROM customers WHERE id = ?', (customer_id,)).fetchone()[0],
        'erpCode': row['erp_code'],
        'city': row['city'],
        'district': row['district'],
        'companyName': row['company_name'] or '-',
        'dealerName': row['dealer_name'] or '-',
        'repName': row['rep_name'] or '-',
        'repUsername': row['rep_username'] or ''
    }


def build_sales_rep_snapshot(conn, rep_id):
    row = conn.execute('''
        SELECT u.id, u.name, u.username, u.password, u.region, u.salesman_code, c.name as company_name
        FROM users u
        LEFT JOIN companies c ON c.id = u.company_id
        WHERE u.id = ? AND u.role = 'sales'
    ''', (rep_id,)).fetchone()
    if not row:
        return None

    return {
        'id': row['id'],
        'name': row['name'],
        'username': row['username'],
        'password': row['password'],
        'companyId': conn.execute('SELECT company_id FROM users WHERE id = ?', (rep_id,)).fetchone()[0],
        'region': row['region'],
        'salesmanCode': row['salesman_code'],
        'companyName': row['company_name'] or '-',
        'customerCount': conn.execute('SELECT COUNT(*) FROM customers WHERE rep_id = ?', (rep_id,)).fetchone()[0],
        'orderCount': conn.execute('SELECT COUNT(*) FROM orders WHERE rep_id = ?', (rep_id,)).fetchone()[0]
    }


def build_product_snapshot(conn, product_id):
    row = conn.execute('SELECT id, name, sku, unit FROM inventory WHERE id = ?', (product_id,)).fetchone()
    if not row:
        return None

    return {
        'id': row['id'],
        'name': row['name'],
        'sku': row['sku'],
        'unit': row['unit'],
        'usageCount': conn.execute('SELECT COUNT(*) FROM order_items WHERE product_id = ?', (product_id,)).fetchone()[0]
    }


def get_deleted_record(conn, deleted_record_id):
    row = conn.execute('''
        SELECT id, entity_type as entityType, entity_id as entityId, display_name as displayName,
               payload, deleted_at as deletedAt
        FROM deleted_records
        WHERE id = ?
    ''', (deleted_record_id,)).fetchone()
    if not row:
        return None
    record = dict(row)
    record['payload'] = json.loads(record.get('payload') or '{}')
    return record


def resolve_company_id(conn, payload):
    company_id = payload.get('companyId')
    if company_id and conn.execute('SELECT 1 FROM companies WHERE id = ?', (company_id,)).fetchone():
        return company_id

    company_name = payload.get('companyName')
    if company_name:
        row = conn.execute('SELECT id FROM companies WHERE name = ?', (company_name,)).fetchone()
        if row:
            return row['id']
    return None


def resolve_sales_rep_id(conn, payload):
    rep_id = payload.get('repId')
    if rep_id and conn.execute("SELECT 1 FROM users WHERE id = ? AND role = 'sales'", (rep_id,)).fetchone():
        return rep_id

    rep_username = payload.get('repUsername')
    if rep_username:
        row = conn.execute("SELECT id FROM users WHERE lower(username) = lower(?) AND role = 'sales'", (rep_username,)).fetchone()
        if row:
            return row['id']

    rep_name = payload.get('repName')
    if rep_name:
        row = conn.execute("SELECT id FROM users WHERE name = ? AND role = 'sales'", (rep_name,)).fetchone()
        if row:
            return row['id']
    return None


def resolve_dealer_id(conn, payload, rep_id, company_id):
    dealer_id = payload.get('dealerId')
    if dealer_id and conn.execute('SELECT 1 FROM dealers WHERE id = ?', (dealer_id,)).fetchone():
        return dealer_id

    dealer_name = payload.get('dealerName')
    if dealer_name:
        row = conn.execute('SELECT id FROM dealers WHERE name = ? AND rep_id = ? ORDER BY rowid LIMIT 1', (dealer_name, rep_id)).fetchone()
        if row:
            return row['id']

    row = conn.execute('SELECT id FROM dealers WHERE rep_id = ? ORDER BY rowid LIMIT 1', (rep_id,)).fetchone()
    if row:
        return row['id']

    dealer_id = make_id('dealer')
    dealer_name = payload.get('dealerName') or f"{payload.get('region') or payload.get('city') or 'Merkez'} Merkez Bayi"
    conn.execute('''
        INSERT INTO dealers (id, name, company_id, rep_id, city, district)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (
        dealer_id,
        dealer_name,
        company_id,
        rep_id,
        payload.get('city') or payload.get('region') or '',
        payload.get('district') or 'Merkez'
    ))
    return dealer_id


def restore_deleted_record(conn, deleted_record_id):
    record = get_deleted_record(conn, deleted_record_id)
    if not record:
        raise ValueError('Silinen kayit bulunamadi.')

    payload = record['payload'] or {}
    entity_type = record['entityType']

    if entity_type == 'inventory':
        if conn.execute('SELECT 1 FROM inventory WHERE id = ?', (record['entityId'],)).fetchone():
            raise ValueError('Bu urun zaten aktif listede.')
        conn.execute('''
            INSERT INTO inventory (id, name, sku, unit)
            VALUES (?, ?, ?, ?)
        ''', (
            record['entityId'],
            payload.get('name') or record['displayName'],
            payload.get('sku') or record['entityId'],
            payload.get('unit') or 'adet'
        ))
    elif entity_type == 'salesRep':
        if conn.execute("SELECT 1 FROM users WHERE id = ? OR lower(username) = lower(?)", (record['entityId'], payload.get('username') or '')).fetchone():
            raise ValueError('Bu satisci zaten aktif listede veya kullanici adi kullanimda.')
        company_id = resolve_company_id(conn, payload)
        if not company_id:
            raise ValueError('Satici geri yuklenemedi. Firma bilgisi eksik.')
        conn.execute('''
            INSERT INTO users (id, name, username, password, role, company_id, region, salesman_code)
            VALUES (?, ?, ?, ?, 'sales', ?, ?, ?)
        ''', (
            record['entityId'],
            payload.get('name') or record['displayName'],
            payload.get('username') or slugify(record['displayName']),
            payload.get('password') or '123456',
            company_id,
            payload.get('region') or '',
            payload.get('salesmanCode') or build_salesman_code(payload.get('name') or record['displayName'])
        ))
        resolve_dealer_id(conn, payload, record['entityId'], company_id)
    elif entity_type == 'customer':
        if conn.execute('SELECT 1 FROM customers WHERE id = ?', (record['entityId'],)).fetchone():
            raise ValueError('Bu musteri zaten aktif listede.')
        company_id = resolve_company_id(conn, payload)
        rep_id = resolve_sales_rep_id(conn, payload)
        if not company_id or not rep_id:
            raise ValueError('Musteriyi geri yuklemek icin once bagli satici aktif olmali.')
        dealer_id = resolve_dealer_id(conn, payload, rep_id, company_id)
        conn.execute('''
            INSERT INTO customers (id, name, company_id, dealer_id, rep_id, city, district, erp_code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            record['entityId'],
            payload.get('name') or record['displayName'],
            company_id,
            dealer_id,
            rep_id,
            payload.get('city') or '',
            payload.get('district') or '',
            payload.get('erpCode') or ''
        ))
    elif entity_type == 'order':
        if conn.execute('SELECT 1 FROM orders WHERE id = ?', (record['entityId'],)).fetchone():
            raise ValueError('Bu siparis zaten aktif listede.')
        customer_id = payload.get('customerId')
        rep_id = resolve_sales_rep_id(conn, payload)
        if not customer_id or not conn.execute('SELECT 1 FROM customers WHERE id = ?', (customer_id,)).fetchone():
            raise ValueError('Siparisi geri yuklemek icin once bagli musteri aktif olmali.')
        if not rep_id:
            raise ValueError('Siparisi geri yuklemek icin once bagli satici aktif olmali.')
        company_id = payload.get('companyId')
        if not company_id:
            customer_row = conn.execute('SELECT company_id FROM customers WHERE id = ?', (customer_id,)).fetchone()
            company_id = customer_row['company_id'] if customer_row else resolve_company_id(conn, payload)
        if not company_id:
            raise ValueError('Siparis geri yuklenemedi. Firma bilgisi eksik.')
        for item in payload.get('items', []):
            if not conn.execute('SELECT 1 FROM inventory WHERE id = ?', (item.get('productId'),)).fetchone():
                raise ValueError('Siparis geri yuklenemedi. En az bir urun aktif listede yok.')
        conn.execute('''
            INSERT INTO orders (
              id, company_id, rep_id, customer_id, delivery_date, payment_term, shipping_owner,
              note, review_status, submission_label, submitted_at, reviewed_at, created_at, updated_at, revision_summary, order_number
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            record['entityId'],
            company_id,
            rep_id,
            customer_id,
            payload.get('deliveryDate') or '',
            payload.get('paymentTerm') or '',
            payload.get('shippingOwner') or '',
            payload.get('note') or '',
            payload.get('reviewStatus') or 'pending',
            payload.get('submissionLabel') or 'Yeni Siparis',
            payload.get('submittedAt') or payload.get('createdAt') or '',
            payload.get('reviewedAt') or '',
            payload.get('createdAt') or payload.get('submittedAt') or '',
            payload.get('updatedAt') or payload.get('submittedAt') or '',
            json.dumps(payload.get('revisionSummary') or [], ensure_ascii=False),
            payload.get('orderNumber')
        ))
        for item in payload.get('items', []):
            conn.execute('''
                INSERT INTO order_items (id, order_id, product_id, quantity, price)
                VALUES (?, ?, ?, ?, ?)
            ''', (
                item.get('id') or make_id('line'),
                record['entityId'],
                item.get('productId'),
                item.get('quantity') or 0,
                item.get('price') or 0
            ))
        restored_number = payload.get('orderNumber')
        if restored_number:
            current_sequence = int(conn.execute("SELECT value FROM app_meta WHERE key = 'order_sequence'").fetchone()[0])
            if int(restored_number) > current_sequence:
                conn.execute("UPDATE app_meta SET value = ? WHERE key = 'order_sequence'", (str(restored_number),))
    else:
        raise ValueError('Bu kayit tipi geri yuklenemiyor.')

    conn.execute('DELETE FROM deleted_records WHERE id = ?', (deleted_record_id,))


def summarize_changes(conn, existing_order, payload):
    changes = []
    field_map = [
        ('deliveryDate', 'Teslim tarihi'),
        ('paymentTerm', 'Vade'),
        ('shippingOwner', 'Nakliye'),
        ('note', 'Not')
    ]
    for key, label in field_map:
        before = existing_order.get(key) or ''
        after = payload.get(key) or ''
        if before != after:
            changes.append(f'{label}: {before or "-"} -> {after or "-"}')

    product_names = {row['id']: row['name'] for row in conn.execute('SELECT id, name FROM inventory').fetchall()}
    current = {item['productId']: item for item in existing_order.get('items', [])}
    nxt = {item['productId']: item for item in payload.get('items', [])}
    for product_id in set(current.keys()) | set(nxt.keys()):
        before = current.get(product_id)
        after = nxt.get(product_id)
        product_name = product_names.get(product_id, 'Urun')
        if before is None and after is not None:
            changes.append(f'Urun eklendi: {product_name} ({after["quantity"]} adet)')
        elif before is not None and after is None:
            changes.append(f'Urun kaldirildi: {product_name}')
        elif before and after and (float(before['quantity']) != float(after['quantity']) or float(before['price']) != float(after['price'])):
            changes.append(f'{product_name}: {before["quantity"]}/{before["price"]} -> {after["quantity"]}/{after["price"]}')
    return changes


def handle_action(payload):
    action = payload.get('action')
    conn = connect()
    try:
        if action == 'bootstrap':
            result = get_bootstrap(conn)
        elif action == 'login':
            row = conn.execute('''
                SELECT id, name, username, role, company_id as companyId, region, salesman_code as salesmanCode
                FROM users WHERE lower(username) = lower(?) AND password = ?
            ''', (payload.get('username', ''), payload.get('password', ''))).fetchone()
            if not row:
                raise ValueError('Kullanici adi veya sifre hatali.')
            result = {'user': dict(row)}
        elif action == 'create_customer':
            dealer = conn.execute('SELECT city, district FROM dealers WHERE id = ?', (payload['dealerId'],)).fetchone()
            customer_id = make_id('customer')
            conn.execute('''
                INSERT INTO customers (id, name, company_id, dealer_id, rep_id, city, district, erp_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                customer_id,
                payload['name'],
                payload['companyId'],
                payload['dealerId'],
                payload['repId'],
                dealer['city'] if dealer else '',
                dealer['district'] if dealer else '',
                (payload.get('erpCode') or '').strip()
            ))
            conn.commit()
            result = {'ok': True, 'id': customer_id}
        elif action == 'update_customer_assignment':
            dealer = conn.execute('SELECT id, city, district FROM dealers WHERE rep_id = ? ORDER BY name LIMIT 1', (payload['repId'],)).fetchone()
            if not dealer:
                raise ValueError('Bu satisciya ait bayi bulunamadi.')
            conn.execute('''
                UPDATE customers SET rep_id = ?, dealer_id = ?, city = ?, district = ?, erp_code = ? WHERE id = ?
            ''', (
                payload['repId'],
                dealer['id'],
                dealer['city'],
                dealer['district'],
                (payload.get('erpCode') or '').strip(),
                payload['customerId']
            ))
            conn.commit()
            result = {'ok': True}
        elif action == 'delete_customer':
            deleted_at = payload['now']
            deleted_by_id = payload.get('deletedById', '')
            deleted_by_name = payload.get('deletedByName', '')
            customer_snapshot = build_customer_snapshot(conn, payload['customerId'])
            if not customer_snapshot:
                raise ValueError('Musteri bulunamadi.')
            order_ids = [row['id'] for row in conn.execute('SELECT id FROM orders WHERE customer_id = ?', (payload['customerId'],)).fetchall()]
            for order_id in order_ids:
                order_snapshot = build_order_snapshot(conn, order_id)
                if order_snapshot:
                    archive_record(conn, 'order', order_id, f"#{order_snapshot['orderNumber'] or '-'} - {order_snapshot['customerName']}", order_snapshot, deleted_at, deleted_by_id, deleted_by_name)
                conn.execute('DELETE FROM order_items WHERE order_id = ?', (order_id,))
            conn.execute('DELETE FROM orders WHERE customer_id = ?', (payload['customerId'],))
            archive_record(conn, 'customer', payload['customerId'], customer_snapshot['name'], {
                **customer_snapshot,
                'archivedOrderCount': len(order_ids)
            }, deleted_at, deleted_by_id, deleted_by_name)
            conn.execute('DELETE FROM customers WHERE id = ?', (payload['customerId'],))
            conn.commit()
            result = {'ok': True}
        elif action == 'create_sales_rep':
            name = (payload.get('name') or '').strip()
            username = (payload.get('username') or '').strip().lower()
            password = (payload.get('password') or '').strip()
            region = (payload.get('region') or '').strip()
            company_id = payload.get('companyId')
            salesman_code = (payload.get('salesmanCode') or '').strip().upper() or build_salesman_code(name)
            if not name or not username or not password or not region or not company_id:
                raise ValueError('Satisci icin tum alanlari doldurun.')
            existing = conn.execute('SELECT 1 FROM users WHERE lower(username) = lower(?)', (username,)).fetchone()
            if existing:
                raise ValueError('Bu kullanici adi zaten kullanimda.')

            rep_id = make_id('rep')
            dealer_id = make_id('dealer')
            dealer_name = f'{region} Merkez Bayi'
            conn.execute('''
                INSERT INTO users (id, name, username, password, role, company_id, region, salesman_code)
                VALUES (?, ?, ?, ?, 'sales', ?, ?, ?)
            ''', (rep_id, name, username, password, company_id, region, salesman_code))
            conn.execute('''
                INSERT INTO dealers (id, name, company_id, rep_id, city, district)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (dealer_id, dealer_name, company_id, rep_id, region, 'Merkez'))
            conn.commit()
            result = {'ok': True, 'id': rep_id}
        elif action == 'get_sales_rep':
            row = conn.execute('''
                SELECT id, name, username, password, company_id as companyId, region, salesman_code as salesmanCode
                FROM users WHERE id = ? AND role = 'sales'
            ''', (payload['repId'],)).fetchone()
            if not row:
                raise ValueError('Satisci bulunamadi.')
            result = {'salesRep': dict(row)}
        elif action == 'update_sales_rep':
            rep_id = payload['repId']
            name = (payload.get('name') or '').strip()
            username = (payload.get('username') or '').strip().lower()
            password = (payload.get('password') or '').strip()
            region = (payload.get('region') or '').strip()
            company_id = payload.get('companyId')
            salesman_code = (payload.get('salesmanCode') or '').strip().upper() or build_salesman_code(name)
            if not name or not username or not password or not region or not company_id:
                raise ValueError('Satisci icin tum alanlari doldurun.')
            existing = conn.execute('SELECT 1 FROM users WHERE lower(username) = lower(?) AND id <> ?', (username, rep_id)).fetchone()
            if existing:
                raise ValueError('Bu kullanici adi zaten kullanimda.')

            cursor = conn.execute('''
                UPDATE users
                SET name = ?, username = ?, password = ?, company_id = ?, region = ?, salesman_code = ?
                WHERE id = ? AND role = 'sales'
            ''', (name, username, password, company_id, region, salesman_code, rep_id))
            if cursor.rowcount == 0:
                raise ValueError('Satisci bulunamadi.')

            dealer = conn.execute('SELECT id FROM dealers WHERE rep_id = ? ORDER BY name LIMIT 1', (rep_id,)).fetchone()
            if dealer:
                conn.execute('''
                    UPDATE dealers
                    SET company_id = ?, city = ?, district = ?, name = ?
                    WHERE id = ?
                ''', (company_id, region, 'Merkez', f'{region} Merkez Bayi', dealer['id']))

            conn.commit()
            result = {'ok': True}
        elif action == 'delete_sales_rep':
            rep_id = payload['repId']
            deleted_at = payload['now']
            deleted_by_id = payload.get('deletedById', '')
            deleted_by_name = payload.get('deletedByName', '')
            rep_snapshot = build_sales_rep_snapshot(conn, rep_id)
            if not rep_snapshot:
                raise ValueError('Satisci bulunamadi.')
            order_ids = [row['id'] for row in conn.execute('SELECT id FROM orders WHERE rep_id = ?', (rep_id,)).fetchall()]
            for order_id in order_ids:
                order_snapshot = build_order_snapshot(conn, order_id)
                if order_snapshot:
                    archive_record(conn, 'order', order_id, f"#{order_snapshot['orderNumber'] or '-'} - {order_snapshot['customerName']}", order_snapshot, deleted_at, deleted_by_id, deleted_by_name)
                conn.execute('DELETE FROM order_items WHERE order_id = ?', (order_id,))
            conn.execute('DELETE FROM orders WHERE rep_id = ?', (rep_id,))

            customer_ids = [row['id'] for row in conn.execute('SELECT id FROM customers WHERE rep_id = ?', (rep_id,)).fetchall()]
            for customer_id in customer_ids:
                customer_snapshot = build_customer_snapshot(conn, customer_id)
                if customer_snapshot:
                    archive_record(conn, 'customer', customer_id, customer_snapshot['name'], customer_snapshot, deleted_at, deleted_by_id, deleted_by_name)
            conn.execute('DELETE FROM customers WHERE rep_id = ?', (rep_id,))

            archive_record(conn, 'salesRep', rep_id, rep_snapshot['name'], {
                **rep_snapshot,
                'archivedCustomerCount': len(customer_ids),
                'archivedOrderCount': len(order_ids)
            }, deleted_at, deleted_by_id, deleted_by_name)
            conn.execute('DELETE FROM dealers WHERE rep_id = ?', (rep_id,))
            conn.execute('DELETE FROM users WHERE id = ? AND role = \'sales\'', (rep_id,))
            conn.commit()
            result = {'ok': True}
        elif action == 'create_product':
            sku = (payload.get('sku') or '').strip()
            name = (payload.get('name') or '').strip()
            unit = (payload.get('unit') or '').strip() or 'adet'
            if not sku or not name:
                raise ValueError('Urun kodu ve urun adi zorunludur.')
            existing = conn.execute('SELECT 1 FROM inventory WHERE lower(sku) = lower(?)', (sku,)).fetchone()
            if existing:
                raise ValueError('Bu stok kodu zaten kayitli.')
            product_id = f'product-{slugify(sku)}'
            conn.execute('''
                INSERT INTO inventory (id, name, sku, unit)
                VALUES (?, ?, ?, ?)
            ''', (product_id, name, sku, unit))
            conn.commit()
            result = {'ok': True, 'id': product_id}
        elif action == 'delete_product':
            product_snapshot = build_product_snapshot(conn, payload['productId'])
            if not product_snapshot:
                raise ValueError('Urun bulunamadi.')
            usage_count = product_snapshot['usageCount']
            if usage_count:
                raise ValueError('Siparislerde kullanilan urun silinemez.')
            archive_record(conn, 'inventory', payload['productId'], product_snapshot['name'], product_snapshot, payload['now'], payload.get('deletedById', ''), payload.get('deletedByName', ''))
            conn.execute('DELETE FROM inventory WHERE id = ?', (payload['productId'],))
            conn.commit()
            result = {'ok': True}
        elif action == 'create_order':
            order_id = make_id('order')
            now = payload['now']
            order_number = get_next_order_number(conn)
            conn.execute('''
                INSERT INTO orders (
                  id, company_id, rep_id, customer_id, delivery_date, payment_term, shipping_owner,
                  note, review_status, submission_label, submitted_at, reviewed_at, created_at, updated_at, revision_summary, order_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (order_id, payload['companyId'], payload['repId'], payload['customerId'], payload.get('deliveryDate', ''),
                  payload.get('paymentTerm', ''), payload.get('shippingOwner', ''), payload.get('note', ''),
                  'pending', 'Yeni Siparis', now, '', now, now, '[]', order_number))
            replace_order_items(conn, order_id, payload.get('items', []))
            conn.commit()
            result = {'ok': True, 'id': order_id, 'orderNumber': order_number}
        elif action == 'update_order':
            existing = next((order for order in get_orders(conn) if order['id'] == payload['orderId']), None)
            if not existing:
                raise ValueError('Siparis bulunamadi.')
            was_locked = existing['reviewStatus'] in ('reviewed', 'rejected')
            revision_summary = summarize_changes(conn, existing, payload) if was_locked else existing.get('revisionSummary', [])
            now = payload['now']
            conn.execute('''
                UPDATE orders
                SET company_id = ?, rep_id = ?, customer_id = ?, delivery_date = ?, payment_term = ?, shipping_owner = ?,
                    note = ?, review_status = ?, submission_label = ?, submitted_at = ?, reviewed_at = ?, updated_at = ?, revision_summary = ?
                WHERE id = ?
            ''', (
                payload['companyId'], payload['repId'], payload['customerId'], payload.get('deliveryDate', ''),
                payload.get('paymentTerm', ''), payload.get('shippingOwner', ''), payload.get('note', ''),
                'pending' if was_locked else existing['reviewStatus'],
                'Revize' if was_locked else existing.get('submissionLabel', 'Yeni Siparis'),
                now, '' if was_locked else existing.get('reviewedAt', ''), now,
                json.dumps(revision_summary, ensure_ascii=False), payload['orderId']
            ))
            replace_order_items(conn, payload['orderId'], payload.get('items', []))
            conn.commit()
            result = {'ok': True}
        elif action == 'approve_order':
            conn.execute('''
                UPDATE orders
                SET review_status = 'reviewed', submission_label = 'Kontrol Edildi', reviewed_at = ?, revision_summary = ?
                WHERE id = ?
            ''', (payload['now'], '[]', payload['orderId']))
            conn.commit()
            result = {'ok': True}
        elif action == 'reject_order':
            conn.execute('''
                UPDATE orders
                SET review_status = 'rejected', submission_label = 'Red', reviewed_at = ?
                WHERE id = ?
            ''', (payload['now'], payload['orderId']))
            conn.commit()
            result = {'ok': True}
        elif action == 'delete_order':
            order_snapshot = build_order_snapshot(conn, payload['orderId'])
            if not order_snapshot:
                raise ValueError('Siparis bulunamadi.')
            archive_record(conn, 'order', payload['orderId'], f"#{order_snapshot['orderNumber'] or '-'} - {order_snapshot['customerName']}", order_snapshot, payload['now'], payload.get('deletedById', ''), payload.get('deletedByName', ''))
            conn.execute('DELETE FROM order_items WHERE order_id = ?', (payload['orderId'],))
            conn.execute('DELETE FROM orders WHERE id = ?', (payload['orderId'],))
            conn.commit()
            result = {'ok': True}
        elif action == 'import_customer_codes':
            result = sync_customer_codes()
        elif action == 'restore_deleted_record':
            restore_deleted_record(conn, payload['deletedRecordId'])
            conn.commit()
            result = {'ok': True}
        else:
            raise ValueError('Bilinmeyen islem.')

        return result
    finally:
        conn.close()


def main():
    payload = json.load(sys.stdin)
    result = handle_action(payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)
