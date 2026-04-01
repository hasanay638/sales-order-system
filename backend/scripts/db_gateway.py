import json
import sqlite3
import sys
import uuid
from pathlib import Path

DB_PATH = Path.home() / 'AppData' / 'Local' / 'sales-order-system' / 'sales-system-v2.sqlite'


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def make_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def rows_to_dicts(rows):
    return [dict(row) for row in rows]


def get_orders(conn):
    orders = rows_to_dicts(conn.execute('''
        SELECT id, company_id as companyId, rep_id as repId, customer_id as customerId,
               delivery_date as deliveryDate, payment_term as paymentTerm,
               shipping_owner as shippingOwner, note, review_status as reviewStatus,
               submission_label as submissionLabel, submitted_at as submittedAt,
               reviewed_at as reviewedAt, created_at as createdAt, updated_at as updatedAt,
               revision_summary as revisionSummary
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


def get_bootstrap(conn):
    return {
        'companies': rows_to_dicts(conn.execute('SELECT id, name FROM companies ORDER BY name').fetchall()),
        'users': rows_to_dicts(conn.execute('''
            SELECT id, name, username, role, company_id as companyId, region
            FROM users ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END, name
        ''').fetchall()),
        'dealers': rows_to_dicts(conn.execute('''
            SELECT id, name, company_id as companyId, rep_id as repId, city, district
            FROM dealers ORDER BY name
        ''').fetchall()),
        'customers': rows_to_dicts(conn.execute('''
            SELECT id, name, company_id as companyId, dealer_id as dealerId, rep_id as repId, city, district
            FROM customers ORDER BY name
        ''').fetchall()),
        'inventory': rows_to_dicts(conn.execute('SELECT id, name, sku, unit FROM inventory ORDER BY name').fetchall()),
        'orders': get_orders(conn)
    }


def replace_order_items(conn, order_id, items):
    conn.execute('DELETE FROM order_items WHERE order_id = ?', (order_id,))
    for item in items:
        conn.execute('''
            INSERT INTO order_items (id, order_id, product_id, quantity, price)
            VALUES (?, ?, ?, ?, ?)
        ''', (item.get('id') or make_id('line'), order_id, item['productId'], item['quantity'], item['price']))


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


def main():
    payload = json.load(sys.stdin)
    action = payload.get('action')
    conn = connect()
    try:
        if action == 'bootstrap':
            result = get_bootstrap(conn)
        elif action == 'login':
            row = conn.execute('''
                SELECT id, name, username, role, company_id as companyId, region
                FROM users WHERE lower(username) = lower(?) AND password = ?
            ''', (payload.get('username', ''), payload.get('password', ''))).fetchone()
            if not row:
                raise ValueError('Kullanici adi veya sifre hatali.')
            result = {'user': dict(row)}
        elif action == 'create_customer':
            dealer = conn.execute('SELECT city, district FROM dealers WHERE id = ?', (payload['dealerId'],)).fetchone()
            customer_id = make_id('customer')
            conn.execute('''
                INSERT INTO customers (id, name, company_id, dealer_id, rep_id, city, district)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (customer_id, payload['name'], payload['companyId'], payload['dealerId'], payload['repId'], dealer['city'] if dealer else '', dealer['district'] if dealer else ''))
            conn.commit()
            result = {'ok': True, 'id': customer_id}
        elif action == 'update_customer_assignment':
            dealer = conn.execute('SELECT id, city, district FROM dealers WHERE rep_id = ? ORDER BY name LIMIT 1', (payload['repId'],)).fetchone()
            if not dealer:
                raise ValueError('Bu satisciya ait bayi bulunamadi.')
            conn.execute('''
                UPDATE customers SET rep_id = ?, dealer_id = ?, city = ?, district = ? WHERE id = ?
            ''', (payload['repId'], dealer['id'], dealer['city'], dealer['district'], payload['customerId']))
            conn.commit()
            result = {'ok': True}
        elif action == 'delete_customer':
            ids = [row['id'] for row in conn.execute('SELECT id FROM orders WHERE customer_id = ?', (payload['customerId'],)).fetchall()]
            for order_id in ids:
                conn.execute('DELETE FROM order_items WHERE order_id = ?', (order_id,))
            conn.execute('DELETE FROM orders WHERE customer_id = ?', (payload['customerId'],))
            conn.execute('DELETE FROM customers WHERE id = ?', (payload['customerId'],))
            conn.commit()
            result = {'ok': True}
        elif action == 'create_order':
            order_id = make_id('order')
            now = payload['now']
            conn.execute('''
                INSERT INTO orders (
                  id, company_id, rep_id, customer_id, delivery_date, payment_term, shipping_owner,
                  note, review_status, submission_label, submitted_at, reviewed_at, created_at, updated_at, revision_summary
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (order_id, payload['companyId'], payload['repId'], payload['customerId'], payload.get('deliveryDate', ''),
                  payload.get('paymentTerm', ''), payload.get('shippingOwner', ''), payload.get('note', ''),
                  'pending', 'Yeni Siparis', now, '', now, now, '[]'))
            replace_order_items(conn, order_id, payload.get('items', []))
            conn.commit()
            result = {'ok': True, 'id': order_id}
        elif action == 'update_order':
            existing = next((order for order in get_orders(conn) if order['id'] == payload['orderId']), None)
            if not existing:
                raise ValueError('Siparis bulunamadi.')
            was_reviewed = existing['reviewStatus'] == 'reviewed'
            revision_summary = summarize_changes(conn, existing, payload) if was_reviewed else existing.get('revisionSummary', [])
            now = payload['now']
            conn.execute('''
                UPDATE orders
                SET company_id = ?, rep_id = ?, customer_id = ?, delivery_date = ?, payment_term = ?, shipping_owner = ?,
                    note = ?, review_status = ?, submission_label = ?, submitted_at = ?, reviewed_at = ?, updated_at = ?, revision_summary = ?
                WHERE id = ?
            ''', (
                payload['companyId'], payload['repId'], payload['customerId'], payload.get('deliveryDate', ''),
                payload.get('paymentTerm', ''), payload.get('shippingOwner', ''), payload.get('note', ''),
                'pending' if was_reviewed else existing['reviewStatus'],
                'Revize' if was_reviewed else existing.get('submissionLabel', 'Yeni Siparis'),
                now, '' if was_reviewed else existing.get('reviewedAt', ''), now,
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
        else:
            raise ValueError('Bilinmeyen islem.')

        print(json.dumps(result, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)
