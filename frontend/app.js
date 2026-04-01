const SESSION_KEY = "sales-order-system-user";
const AUTH_KEY = "sales-order-system-auth";

const defaultSeedState = {
  companies: [],
  users: [],
  dealers: [],
  customers: [],
  inventory: [],
  orders: [],
  deletedRecords: []
};

const seedState = window.BOOTSTRAP_STATE || defaultSeedState;
const ADMIN_LIST_PREVIEW_LIMIT = 5;

const els = {};
let state = loadState();
let currentUserId = loadSessionUserId();
let showAllCustomers = false;
let showAllProducts = false;
let salesRepEditCacheId = "";
let adminReviewedSearch = "";
let salesOrdersSearch = "";
let deletedRecordsTab = "orders";
let lastAssignmentCustomerId = "";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loadState() {
  return structuredClone(seedState);
}

function saveState() {
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || "API istegi basarisiz oldu.");
  }

  return response.status === 204 ? null : response.json();
}

async function refreshState() {
  state = await apiRequest("./api/bootstrap");
  normalizeOrders();
}

function normalizeOrders() {
  state.orders = state.orders.map((order) => ({
    reviewStatus: "pending",
    submissionLabel: "Yeni Siparis",
    submittedAt: order.updatedAt || order.createdAt || new Date().toISOString(),
    reviewedAt: "",
    revisionSummary: [],
    ...order
  }));
}

function loadSessionUserId() {
  const isAuthenticated = localStorage.getItem(AUTH_KEY) === "true";
  const stored = localStorage.getItem(SESSION_KEY);
  if (isAuthenticated && stored && (seedState.users || []).some((user) => user.id === stored)) {
    return stored;
  }

  return null;
}

normalizeOrders();

function saveSessionUserId(userId) {
  currentUserId = userId;
  localStorage.setItem(SESSION_KEY, userId);
  localStorage.setItem(AUTH_KEY, "true");
}

function byId(collection, id) {
  return collection.find((item) => item.id === id);
}

function getCurrentUser() {
  return byId(state.users, currentUserId) || null;
}

function getDeleteRequestOptions() {
  const currentUser = getCurrentUser();
  return {
    method: "DELETE",
    headers: {
      "X-User-Id": currentUser?.id || "",
      "X-User-Name": currentUser?.name || ""
    }
  };
}

function getRepUsers() {
  return state.users.filter((user) => user.role === "sales");
}

function getDealerForCustomer(customer) {
  return byId(state.dealers, customer.dealerId);
}

function getCompanyName(companyId) {
  return byId(state.companies, companyId)?.name || "-";
}

function getRepName(repId) {
  return byId(state.users, repId)?.name || "-";
}

function getProduct(productId) {
  return byId(state.inventory, productId);
}

function getShortCustomerLabel(customer) {
  const words = String(customer?.name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "-";
  }
  const shortLabel = words.slice(0, 4).join(" ");
  return words.length > 4 ? `${shortLabel}...` : shortLabel;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function customerMatchesSearch(customerName, query) {
  if (!query) {
    return true;
  }

  return normalizeSearchText(customerName).includes(normalizeSearchText(query));
}

function getOrderStatusLabel(order) {
  if (order.reviewStatus === "reviewed") {
    return "Kontrol edildi";
  }

  if (order.reviewStatus === "rejected") {
    return "Red";
  }

  return order.submissionLabel || "Yeni Siparis";
}

function getOrderTagClass(order) {
  if (order.reviewStatus === "rejected" || order.submissionLabel === "Red") {
    return "tag-danger";
  }

  if (order.submissionLabel === "Revize") {
    return "tag-warning";
  }

  if (order.reviewStatus === "reviewed" || order.submissionLabel === "Kontrol Edildi") {
    return "tag-success";
  }

  return "tag-info";
}

function getVisibleCustomers(user) {
  if (user.role === "admin") {
    return [...state.customers];
  }

  return state.customers.filter((customer) => customer.repId === user.id);
}

function getVisibleOrders(user) {
  if (user.role === "admin") {
    return [...state.orders];
  }

  return state.orders.filter((order) => order.repId === user.id);
}

function getOrdersTotal(order) {
  return order.items.reduce((sum, item) => sum + (Number(item.quantity) * Number(item.price)), 0);
}

function getOrderTotalKg(order) {
  return order.items.reduce((sum, item) => {
    const bagKg = Number(item?.erpPayload?.BAG_KG || 50);
    return sum + (Number(item.quantity) * bagKg);
  }, 0);
}

function formatMoney(value) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatKg(value) {
  return new Intl.NumberFormat("tr-TR", {
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function isToday(value) {
  if (!value) {
    return false;
  }

  const date = new Date(value);
  const today = new Date();

  return date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function buildPreviewRows(items, renderRow, expanded, emptyMessage) {
  if (!items.length) {
    return {
      rows: `<tr><td colspan="10">${emptyMessage}</td></tr>`,
      hasMore: false
    };
  }

  const visibleItems = expanded ? items : items.slice(0, ADMIN_LIST_PREVIEW_LIMIT);
  return {
    rows: visibleItems.map(renderRow).join(""),
    hasMore: items.length > ADMIN_LIST_PREVIEW_LIMIT
  };
}

function summarizeOrderChanges(previousOrder, nextPayload) {
  const changes = [];

  const fieldMap = [
    { key: "deliveryDate", label: "Teslim tarihi", formatter: formatDate },
    { key: "paymentTerm", label: "Vade", formatter: (value) => value || "-" },
    { key: "shippingOwner", label: "Nakliye", formatter: (value) => value || "-" },
    { key: "note", label: "Not", formatter: (value) => value || "-" }
  ];

  fieldMap.forEach(({ key, label, formatter }) => {
    const previousValue = previousOrder[key] || "";
    const nextValue = nextPayload[key] || "";
    if (previousValue !== nextValue) {
      changes.push(`${label}: ${formatter(previousValue)} -> ${formatter(nextValue)}`);
    }
  });

  const previousItems = previousOrder.items.map((item) => ({
    productId: item.productId,
    quantity: Number(item.quantity),
    price: Number(item.price)
  }));
  const nextItems = nextPayload.items.map((item) => ({
    productId: item.productId,
    quantity: Number(item.quantity),
    price: Number(item.price)
  }));

  const previousMap = new Map(previousItems.map((item) => [item.productId, item]));
  const nextMap = new Map(nextItems.map((item) => [item.productId, item]));
  const productIds = new Set([...previousMap.keys(), ...nextMap.keys()]);

  productIds.forEach((productId) => {
    const previousItem = previousMap.get(productId);
    const nextItem = nextMap.get(productId);
    const productName = getProduct(productId)?.name || "Urun";

    if (!previousItem && nextItem) {
      changes.push(`Urun eklendi: ${productName} (${nextItem.quantity} adet x ${formatMoney(nextItem.price)})`);
      return;
    }

    if (previousItem && !nextItem) {
      changes.push(`Urun kaldirildi: ${productName}`);
      return;
    }

    if (previousItem.quantity !== nextItem.quantity || previousItem.price !== nextItem.price) {
      changes.push(
        `${productName}: ${previousItem.quantity} adet / ${formatMoney(previousItem.price)} -> ${nextItem.quantity} adet / ${formatMoney(nextItem.price)}`
      );
    }
  });

  return changes;
}

function renderOrderItemsDetails(order) {
  if (!order.items?.length) {
    return `<div class="muted-card admin-order-section">Urun kalemi yok.</div>`;
  }

  const rows = order.items.map((item) => {
    const product = getProduct(item.productId);
    const lineTotal = Number(item.quantity) * Number(item.price);
    return `
      <tr>
        <td>${product?.name || "Urun"}</td>
        <td>${item.quantity}</td>
        <td>${formatMoney(item.price)}</td>
        <td>${formatMoney(lineTotal)}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="admin-order-section">
      <h4>Urun detaylari</h4>
      <div class="table-wrap">
        <table class="compact-table">
          <thead>
            <tr>
              <th>Urun</th>
              <th>Adet</th>
              <th>Birim fiyat</th>
              <th>Ara toplam</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderErpOrderSummary(order) {
  const erp = order.erpPayload || {};
  const fields = [
    ["ERP siparis no", erp.NUMBER || order.erpOrderNumber || order.orderNumber || "-"],
    ["ERP musteri kodu", erp.ARP_CODE || order.erpCustomerCode || "-"],
    ["Siparis tarihi", erp.DATE || order.erpOrderDate || order.deliveryDate || "-"],
    ["Belge takip no", erp.DOC_TRACK_NR || order.erpDocTrackNr || "-"],
    ["Satisci kodu", erp.SALESMAN_CODE || "-"],
    ["Depo", erp.SOURCE_WH || "-"],
    ["Maliyet grubu", erp.SOURCE_COST_GRP || "-"],
    ["Bolum", erp.DIVISION || "-"],
    ["Fabrika", erp.FACTORY || "-"],
    ["Odeme kodu", erp.PAYMENT_CODE || order.paymentTerm || "-"],
    ["Toplam iskontolu", erp.TOTAL_DISCOUNTED != null ? formatMoney(erp.TOTAL_DISCOUNTED) : "-"],
    ["Toplam KDV", erp.TOTAL_VAT != null ? formatMoney(erp.TOTAL_VAT) : "-"],
    ["Toplam brut", erp.TOTAL_GROSS != null ? formatMoney(erp.TOTAL_GROSS) : "-"],
    ["Toplam net", erp.TOTAL_NET != null ? formatMoney(erp.TOTAL_NET) : "-"]
  ];

  const notes = [
    erp.NOTES1,
    erp.NOTES2,
    erp.NOTES3,
    erp.NOTES4
  ].filter(Boolean);

  const rows = fields.map(([label, value]) => `<p><strong>${label}:</strong> ${value || "-"}</p>`).join("");
  const notesMarkup = notes.length
    ? `<div class="admin-order-section"><h4>ERP notlari</h4><ul class="revision-list">${notes.map((note) => `<li>${note}</li>`).join("")}</ul></div>`
    : "";

  return `
    <div class="admin-order-section">
      <h4>ERP / XML cikti ozeti</h4>
      <div class="admin-order-grid">${rows}</div>
    </div>
    ${notesMarkup}
  `;
}

function renderErpLineDetails(order) {
  if (!order.items?.length) {
    return "";
  }

  const rows = order.items.map((item) => {
    const product = getProduct(item.productId);
    const erp = item.erpPayload || {};
    return `
      <tr>
        <td>${erp.MASTER_CODE || product?.sku || "-"}</td>
        <td>${product?.name || erp.PRODUCT_NAME || "Urun"}</td>
        <td>${erp.UNIT_CODE || "-"}</td>
        <td>${erp.QUANTITY ?? item.quantity}</td>
        <td>${formatMoney(erp.PRICE ?? item.price)}</td>
        <td>${formatMoney(erp.TOTAL ?? (Number(item.quantity) * Number(item.price)))}</td>
        <td>${erp.DUE_DATE || order.deliveryDate || "-"}</td>
        <td>${erp.SALESMAN_CODE || "-"}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="admin-order-section">
      <h4>ERP satir ciktilari</h4>
      <div class="table-wrap">
        <table class="compact-table">
          <thead>
            <tr>
              <th>Stok kodu</th>
              <th>Urun</th>
              <th>Birim</th>
              <th>Miktar</th>
              <th>Fiyat</th>
              <th>Toplam</th>
              <th>Vade tarihi</th>
              <th>Satisci kodu</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderRevisionSummary(order) {
  if (order.submissionLabel !== "Revize" || !order.revisionSummary?.length) {
    return "";
  }

  const items = order.revisionSummary.map((change) => `<li>${change}</li>`).join("");
  return `
    <div class="admin-order-section revision-box">
      <h4>Revize edilen alanlar</h4>
      <ul class="revision-list">${items}</ul>
    </div>
  `;
}

function hydrateElements() {
  els.sessionUserName = document.getElementById("sessionUserName");
  els.sessionMeta = document.getElementById("sessionMeta");
  els.resetDataButton = document.getElementById("resetDataButton");
  els.logoutButton = document.getElementById("logoutButton");
  els.metricsGrid = document.getElementById("metricsGrid");
  els.generalMetricsPanel = document.getElementById("generalMetricsPanel");
  els.adminMetricsGrid = document.getElementById("adminMetricsGrid");
  els.adminPanel = document.getElementById("adminPanel");
  els.salesPanel = document.getElementById("salesPanel");
  els.customerForm = document.getElementById("customerForm");
  els.customerCompanySelect = document.getElementById("customerCompanySelect");
  els.customerDealerSelect = document.getElementById("customerDealerSelect");
  els.customerRepSelect = document.getElementById("customerRepSelect");
  els.customerErpCodeInput = document.getElementById("customerErpCodeInput");
  els.assignmentForm = document.getElementById("assignmentForm");
  els.assignmentCustomerSelect = document.getElementById("assignmentCustomerSelect");
  els.assignmentRepSelect = document.getElementById("assignmentRepSelect");
  els.assignmentCustomerErpCodeInput = document.getElementById("assignmentCustomerErpCodeInput");
  els.assignmentCurrentRepInput = document.getElementById("assignmentCurrentRepInput");
  els.bulkTransferForm = document.getElementById("bulkTransferForm");
  els.bulkTransferSourceRepSelect = document.getElementById("bulkTransferSourceRepSelect");
  els.bulkTransferTargetRepSelect = document.getElementById("bulkTransferTargetRepSelect");
  els.bulkTransferSummary = document.getElementById("bulkTransferSummary");
  els.removeCustomerButton = document.getElementById("removeCustomerButton");
  els.importCustomerCodesButton = document.getElementById("importCustomerCodesButton");
  els.customerTable = document.getElementById("customerTable");
  els.salesRepForm = document.getElementById("salesRepForm");
  els.salesRepCompanySelect = document.getElementById("salesRepCompanySelect");
  els.salesRepCodeInput = document.getElementById("salesRepCodeInput");
  els.salesRepEditForm = document.getElementById("salesRepEditForm");
  els.salesRepEditSelect = document.getElementById("salesRepEditSelect");
  els.salesRepEditNameInput = document.getElementById("salesRepEditNameInput");
  els.salesRepEditUsernameInput = document.getElementById("salesRepEditUsernameInput");
  els.salesRepEditCodeInput = document.getElementById("salesRepEditCodeInput");
  els.salesRepEditPasswordInput = document.getElementById("salesRepEditPasswordInput");
  els.salesRepEditRegionInput = document.getElementById("salesRepEditRegionInput");
  els.salesRepEditCompanySelect = document.getElementById("salesRepEditCompanySelect");
  els.salesRepDeleteSelect = document.getElementById("salesRepDeleteSelect");
  els.removeSalesRepButton = document.getElementById("removeSalesRepButton");
  els.salesRepTable = document.getElementById("salesRepTable");
  els.productForm = document.getElementById("productForm");
  els.productDeleteSelect = document.getElementById("productDeleteSelect");
  els.removeProductButton = document.getElementById("removeProductButton");
  els.productTable = document.getElementById("productTable");
  els.adminPendingOrdersList = document.getElementById("adminPendingOrdersList");
  els.adminReviewedOrdersList = document.getElementById("adminReviewedOrdersList");
  els.adminReviewedSearchInput = document.getElementById("adminReviewedSearchInput");
  els.salesScopeTag = document.getElementById("salesScopeTag");
  els.orderForm = document.getElementById("orderForm");
  els.orderIdInput = document.getElementById("orderIdInput");
  els.orderCustomerSelect = document.getElementById("orderCustomerSelect");
  els.customerSnapshot = document.getElementById("customerSnapshot");
  els.orderLines = document.getElementById("orderLines");
  els.lineItemTemplate = document.getElementById("lineItemTemplate");
  els.addLineButton = document.getElementById("addLineButton");
  els.deliveryDateInput = document.getElementById("deliveryDateInput");
  els.paymentTermInput = document.getElementById("paymentTermInput");
  els.shippingOwnerSelect = document.getElementById("shippingOwnerSelect");
  els.orderNoteInput = document.getElementById("orderNoteInput");
  els.clearOrderButton = document.getElementById("clearOrderButton");
  els.salesPendingOrdersList = document.getElementById("salesPendingOrdersList");
  els.salesReviewedOrdersList = document.getElementById("salesReviewedOrdersList");
  els.salesOrdersSearchInput = document.getElementById("salesOrdersSearchInput");
  els.deletedRecordsPanel = document.getElementById("deletedRecordsPanel");
  els.deletedRecordsTabs = document.getElementById("deletedRecordsTabs");
  els.deletedRecordsContent = document.getElementById("deletedRecordsContent");
}

function hasElement(element) {
  return Boolean(element);
}

function populateSelect(select, items, formatter, placeholder) {
  const options = [];

  if (placeholder) {
    options.push(`<option value="">${placeholder}</option>`);
  }

  items.forEach((item) => {
    options.push(`<option value="${item.id}">${formatter(item)}</option>`);
  });

  select.innerHTML = options.join("");
}

function renderMetrics() {
  if (!hasElement(els.metricsGrid) && !hasElement(els.adminMetricsGrid)) {
    return;
  }

  const currentUser = getCurrentUser();
  let cards;

  if (currentUser.role === "admin") {
    const dailyOrders = state.orders.filter((order) => isToday(order.submittedAt));
    const reviewedOrders = state.orders.filter((order) => order.reviewStatus !== "pending");
    const pendingOrders = state.orders.filter((order) => order.reviewStatus === "pending");

    cards = [
      { label: "Gunluk girilen siparisler", value: dailyOrders.length },
      { label: "Bakilan siparisler", value: reviewedOrders.length },
      { label: "Bakilmayan siparisler", value: pendingOrders.length }
    ];
  } else {
    const visibleCustomers = getVisibleCustomers(currentUser);
    const visibleOrders = getVisibleOrders(currentUser);
    const visibleDealers = state.dealers.filter((dealer) => dealer.repId === currentUser.id);

    cards = [
      { label: "Bagli bayi", value: visibleDealers.length },
      { label: "Gorunen musteri", value: visibleCustomers.length },
      { label: "Siparis sayisi", value: visibleOrders.length }
    ];
  }

  const markup = cards.map((card) => `
    <article class="metric-card">
      <span class="eyebrow">${card.label}</span>
      <strong>${card.value}</strong>
    </article>
  `).join("");

  if (currentUser.role === "admin") {
    if (hasElement(els.generalMetricsPanel)) {
      els.generalMetricsPanel.classList.add("hidden");
    }
    if (hasElement(els.adminMetricsGrid)) {
      els.adminMetricsGrid.innerHTML = markup;
    }
  } else {
    if (hasElement(els.generalMetricsPanel)) {
      els.generalMetricsPanel.classList.remove("hidden");
    }
    if (hasElement(els.metricsGrid)) {
      els.metricsGrid.innerHTML = markup;
    }
    if (hasElement(els.adminMetricsGrid)) {
      els.adminMetricsGrid.innerHTML = "";
    }
  }
}

function renderAdminPanel() {
  const hasAdminContent = hasElement(els.adminPanel) || hasElement(els.customerTable) || hasElement(els.productTable) || hasElement(els.salesRepTable);
  if (!hasAdminContent) {
    return;
  }

  const currentUser = getCurrentUser();
  const showAdmin = currentUser.role === "admin";
  if (hasElement(els.adminPanel)) {
    els.adminPanel.classList.toggle("hidden", !showAdmin);
  }

  if (!showAdmin) {
    if (!hasElement(els.adminPanel)) {
      window.location.href = "./order-create.html";
    }
    return;
  }

  if (hasElement(els.customerCompanySelect)) {
    populateSelect(els.customerCompanySelect, state.companies, (company) => company.name, null);
  }
  if (hasElement(els.customerRepSelect)) {
    populateSelect(els.customerRepSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.region}`, null);
  }
  if (hasElement(els.salesRepCompanySelect)) {
    populateSelect(els.salesRepCompanySelect, state.companies, (company) => company.name, null);
  }
  if (hasElement(els.salesRepEditCompanySelect)) {
    populateSelect(els.salesRepEditCompanySelect, state.companies, (company) => company.name, null);
  }
  if (hasElement(els.assignmentRepSelect)) {
    populateSelect(els.assignmentRepSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.region}`, null);
  }
  if (hasElement(els.bulkTransferSourceRepSelect)) {
    populateSelect(els.bulkTransferSourceRepSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.region}`, null);
  }
  if (hasElement(els.bulkTransferTargetRepSelect)) {
    populateSelect(els.bulkTransferTargetRepSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.region}`, null);
  }
  if (hasElement(els.salesRepDeleteSelect)) {
    populateSelect(els.salesRepDeleteSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.region}`, null);
  }
  if (hasElement(els.salesRepEditSelect)) {
    populateSelect(els.salesRepEditSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.username}`, null);
  }
  if (hasElement(els.assignmentCustomerSelect)) {
    populateSelect(els.assignmentCustomerSelect, state.customers, (customer) => customer.name, null);
  }
  if (hasElement(els.productDeleteSelect)) {
    populateSelect(els.productDeleteSelect, state.inventory, (product) => `${product.name} (${product.sku})`, null);
  }

  if (hasElement(els.customerDealerSelect) && hasElement(els.customerRepSelect)) {
    syncDealerOptions();
  }
  if (hasElement(els.assignmentRepSelect) && !els.assignmentRepSelect.value && getRepUsers()[0]) {
    els.assignmentRepSelect.value = getRepUsers()[0].id;
  }
  if (hasElement(els.assignmentCustomerSelect)) {
    const preferredCustomerId = lastAssignmentCustomerId && state.customers.some((customer) => customer.id === lastAssignmentCustomerId)
      ? lastAssignmentCustomerId
      : els.assignmentCustomerSelect.value;
    if (preferredCustomerId && state.customers.some((customer) => customer.id === preferredCustomerId)) {
      els.assignmentCustomerSelect.value = preferredCustomerId;
    } else if (state.customers[0]) {
      els.assignmentCustomerSelect.value = state.customers[0].id;
    }
  }
  syncAssignmentCustomerMeta();
  syncBulkTransferSummary();
  if (hasElement(els.salesRepEditSelect) && !els.salesRepEditSelect.value && getRepUsers()[0]) {
    els.salesRepEditSelect.value = getRepUsers()[0].id;
  }
  if (hasElement(els.salesRepEditSelect) && els.salesRepEditSelect.value && salesRepEditCacheId !== els.salesRepEditSelect.value) {
    loadSalesRepIntoEditForm(els.salesRepEditSelect.value).catch(console.error);
  }

  if (hasElement(els.customerTable)) {
    const customerRows = buildPreviewRows(
      state.customers,
      (customer) => {
        const dealer = getDealerForCustomer(customer);
        const rep = byId(state.users, customer.repId);
        return `
          <tr>
            <td>${customer.name}</td>
            <td>${customer.erpCode || "-"}</td>
            <td>${getCompanyName(customer.companyId)}</td>
            <td>${dealer?.name || "-"}</td>
            <td>${rep?.name || "-"}</td>
            <td>${rep?.region || "-"}</td>
          </tr>
        `;
      },
      showAllCustomers,
      "Kayitli musteri bulunmuyor."
    );

    els.customerTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Musteri</th>
          <th>ERP kodu</th>
          <th>Firma</th>
          <th>Bayi</th>
          <th>Satici</th>
          <th>Bolge</th>
        </tr>
      </thead>
      <tbody>
        ${customerRows.rows}
      </tbody>
    </table>
    ${customerRows.hasMore ? `<button class="ghost-button list-toggle-button" type="button" data-show-all-customers>${showAllCustomers ? "Listeyi daralt" : "Devamini goster"}</button>` : ""}
  `;
  }

  if (hasElement(els.salesRepTable)) {
    const salesReps = getRepUsers();
    els.salesRepTable.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Satici</th>
            <th>Kullanici adi</th>
            <th>XML kodu</th>
            <th>Bolge</th>
            <th>Firma</th>
            <th>Musteri</th>
            <th>Siparis</th>
          </tr>
        </thead>
        <tbody>
          ${salesReps.map((rep) => `
            <tr>
              <td>${rep.name}</td>
              <td>${rep.username}</td>
              <td>${rep.salesmanCode || "-"}</td>
              <td>${rep.region || "-"}</td>
              <td>${getCompanyName(rep.companyId)}</td>
              <td>${state.customers.filter((customer) => customer.repId === rep.id).length}</td>
              <td>${state.orders.filter((order) => order.repId === rep.id).length}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  if (hasElement(els.productTable)) {
    const productRows = buildPreviewRows(
      state.inventory,
      (product) => `
        <tr>
          <td>${product.sku}</td>
          <td>${product.name}</td>
          <td>${product.unit || "-"}</td>
          <td>${state.orders.reduce((count, order) => count + order.items.filter((item) => item.productId === product.id).length, 0)}</td>
        </tr>
      `,
      showAllProducts,
      "Kayitli urun bulunmuyor."
    );

    els.productTable.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Stok kodu</th>
            <th>Urun adi</th>
            <th>Birim</th>
            <th>Kullanim</th>
          </tr>
        </thead>
        <tbody>
          ${productRows.rows}
        </tbody>
      </table>
      ${productRows.hasMore ? `<button class="ghost-button list-toggle-button" type="button" data-show-all-products>${showAllProducts ? "Listeyi daralt" : "Devamini goster"}</button>` : ""}
    `;
  }

  if (hasElement(els.adminPendingOrdersList) || hasElement(els.adminReviewedOrdersList)) {
    renderAdminOrdersList();
  }

  if (hasElement(els.customerTable)) {
    els.customerTable.querySelectorAll("[data-show-all-customers]").forEach((button) => {
      button.addEventListener("click", () => {
        showAllCustomers = !showAllCustomers;
        renderAdminPanel();
      });
    });
  }

  if (hasElement(els.productTable)) {
    els.productTable.querySelectorAll("[data-show-all-products]").forEach((button) => {
      button.addEventListener("click", () => {
        showAllProducts = !showAllProducts;
        renderAdminPanel();
      });
    });
  }
}

function renderDeletedRecordsPage() {
  if (!hasElement(els.deletedRecordsPanel) || !hasElement(els.deletedRecordsTabs) || !hasElement(els.deletedRecordsContent)) {
    return;
  }

  const currentUser = getCurrentUser();
  const showAdmin = currentUser.role === "admin";
  els.deletedRecordsPanel.classList.toggle("hidden", !showAdmin);
  if (!showAdmin) {
    window.location.href = "./order-create.html";
    return;
  }

  const tabs = [
    { id: "orders", label: "Siparisler", type: "order" },
    { id: "customers", label: "Musteriler", type: "customer" },
    { id: "salesReps", label: "Satiscilar", type: "salesRep" },
    { id: "inventory", label: "Stok kartlari", type: "inventory" }
  ];

  els.deletedRecordsTabs.innerHTML = tabs.map((tab) => `
    <button class="${deletedRecordsTab === tab.id ? "" : "ghost-button"}" type="button" data-deleted-tab="${tab.id}">
      ${tab.label}
    </button>
  `).join("");

  const activeTab = tabs.find((tab) => tab.id === deletedRecordsTab) || tabs[0];
  const records = (state.deletedRecords || []).filter((record) => record.entityType === activeTab.type);

  if (!records.length) {
    els.deletedRecordsContent.innerHTML = `<div class="info-card muted-card">Bu sekmede silinen kayit yok.</div>`;
  } else if (activeTab.id === "orders") {
    els.deletedRecordsContent.innerHTML = records.map((record) => {
      const payload = record.payload || {};
      const items = (payload.items || []).map((item) => `
        <li>${item.productName || item.sku || "Urun"} - ${item.quantity} x ${formatMoney(item.price)}</li>
      `).join("");

      return `
        <article class="order-card deleted-record-card">
          <div class="panel-title-row">
            <div>
              <strong>${record.displayName}</strong>
              <p class="muted">${payload.repName || "-"} | ${payload.companyName || "-"} | ${formatDateTime(record.deletedAt)}</p>
              ${record.deletedByName ? `<p class="deleted-by-text">Silen kisi: ${escapeHtml(record.deletedByName)}</p>` : ""}
            </div>
            <div class="deleted-record-actions">
              <span class="tag">${formatKg(payload.totalKg || 0)} kg</span>
              <button type="button" data-deleted-record-restore="${record.id}">Geri yukle</button>
            </div>
          </div>
          <p><strong>Musteri:</strong> ${payload.customerName || "-"}</p>
          <p><strong>Durum:</strong> ${payload.reviewStatus || "-"}</p>
          <p><strong>Not:</strong> ${payload.note || "-"}</p>
          <ul>${items || "<li>Urun kalemi yok.</li>"}</ul>
        </article>
      `;
    }).join("");
  } else {
    els.deletedRecordsContent.innerHTML = records.map((record) => {
      const payload = record.payload || {};
      const rows = Object.entries(payload)
        .filter(([, value]) => value !== "" && value !== null && value !== undefined && !Array.isArray(value) && typeof value !== "object")
        .map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`)
        .join("");

      return `
        <article class="order-card deleted-record-card">
          <div class="panel-title-row">
            <div>
              <strong>${record.displayName}</strong>
              <p class="muted">${formatDateTime(record.deletedAt)}</p>
              ${record.deletedByName ? `<p class="deleted-by-text">Silen kisi: ${escapeHtml(record.deletedByName)}</p>` : ""}
            </div>
            <button type="button" data-deleted-record-restore="${record.id}">Geri yukle</button>
          </div>
          ${rows || `<p class="muted">Detay bulunmuyor.</p>`}
        </article>
      `;
    }).join("");
  }

  els.deletedRecordsTabs.querySelectorAll("[data-deleted-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      deletedRecordsTab = button.dataset.deletedTab;
      renderDeletedRecordsPage();
    });
  });
  els.deletedRecordsContent.querySelectorAll("[data-deleted-record-restore]").forEach((button) => {
    button.addEventListener("click", () => restoreDeletedRecord(button.dataset.deletedRecordRestore));
  });
}

async function restoreDeletedRecord(deletedRecordId) {
  await apiRequest(`./api/deleted-records/${deletedRecordId}/restore`, { method: "POST" });
  await refreshState();
  renderAll();
}

function syncDealerOptions() {
  if (!hasElement(els.customerRepSelect) || !hasElement(els.customerDealerSelect)) {
    return;
  }

  const selectedRepId = els.customerRepSelect.value || getRepUsers()[0]?.id;
  const repDealers = state.dealers.filter((dealer) => dealer.repId === selectedRepId);
  populateSelect(els.customerDealerSelect, repDealers, (dealer) => dealer.name, null);
}

function syncAssignmentCustomerMeta() {
  if (!hasElement(els.assignmentCustomerSelect) || !hasElement(els.assignmentCustomerErpCodeInput)) {
    return;
  }

  const customer = byId(state.customers, els.assignmentCustomerSelect.value);
  lastAssignmentCustomerId = customer?.id || "";
  els.assignmentCustomerErpCodeInput.value = customer?.erpCode || "";
  if (hasElement(els.assignmentCurrentRepInput)) {
    els.assignmentCurrentRepInput.value = customer ? getRepName(customer.repId) : "";
  }
}

function syncBulkTransferSummary() {
  if (!hasElement(els.bulkTransferSummary) || !hasElement(els.bulkTransferSourceRepSelect) || !hasElement(els.bulkTransferTargetRepSelect)) {
    return;
  }

  const sourceRep = byId(state.users, els.bulkTransferSourceRepSelect.value);
  const targetRep = byId(state.users, els.bulkTransferTargetRepSelect.value);
  if (!sourceRep || !targetRep) {
    els.bulkTransferSummary.textContent = "Toplu devri baslatmak icin kaynak ve hedef saticiyi sec.";
    return;
  }

  const transferableCount = state.customers.filter((customer) => customer.repId === sourceRep.id).length;
  els.bulkTransferSummary.textContent = `${sourceRep.name} uzerindeki ${transferableCount} musteri, ${targetRep.name} uzerine devredilecek.`;
}

async function loadSalesRepIntoEditForm(repId) {
  if (!hasElement(els.salesRepEditForm) || !repId) {
    return;
  }

  const payload = await apiRequest(`./api/sales-reps/${repId}`);
  const salesRep = payload.salesRep;
  salesRepEditCacheId = salesRep.id;
  els.salesRepEditSelect.value = salesRep.id;
  if (hasElement(els.salesRepDeleteSelect)) {
    els.salesRepDeleteSelect.value = salesRep.id;
  }
  els.salesRepEditNameInput.value = salesRep.name || "";
  els.salesRepEditUsernameInput.value = salesRep.username || "";
  els.salesRepEditCodeInput.value = salesRep.salesmanCode || "";
  els.salesRepEditPasswordInput.value = salesRep.password || "";
  els.salesRepEditRegionInput.value = salesRep.region || "";
  els.salesRepEditCompanySelect.value = salesRep.companyId || "";
}

function renderSalesPanel() {
  if (!hasElement(els.salesPanel)) {
    return;
  }

  const currentUser = getCurrentUser();
  const showSales = currentUser.role === "sales";
  els.salesPanel.classList.toggle("hidden", !showSales);

  if (!showSales) {
    return;
  }

  const visibleCustomers = getVisibleCustomers(currentUser);
  populateSelect(els.orderCustomerSelect, visibleCustomers, (customer) => getShortCustomerLabel(customer), "Musteri secin");
  els.salesScopeTag.textContent = `${currentUser.name} - ${currentUser.region}`;

  if (!visibleCustomers.some((customer) => customer.id === els.orderCustomerSelect.value)) {
    els.orderCustomerSelect.value = "";
  }

  renderCustomerSnapshot();
  renderOrdersList();
  toggleOrderLinesAvailability();
}

function renderCustomerSnapshot() {
  const customer = byId(state.customers, els.orderCustomerSelect.value);
  if (!customer) {
    els.customerSnapshot.textContent = "Musteri secildikten sonra bayi ve firma bilgisi burada gorunur.";
    return;
  }

  const dealer = getDealerForCustomer(customer);
  const rep = byId(state.users, customer.repId);
  els.customerSnapshot.innerHTML = `
    <strong>${customer.name}</strong>
    <p>Firma: ${getCompanyName(customer.companyId)}</p>
    <p>Bayi: ${dealer?.name || "-"}</p>
    <p>Satici: ${rep?.name || "-"}</p>
  `;
}

function toggleOrderLinesAvailability() {
  const hasCustomer = Boolean(els.orderCustomerSelect.value);
  els.orderLines.classList.toggle("disabled", !hasCustomer);
  els.addLineButton.disabled = !hasCustomer;
}

function addLineItem(item = {}) {
  const fragment = els.lineItemTemplate.content.cloneNode(true);
  const line = fragment.querySelector(".line-item");
  const productSelect = fragment.querySelector(".line-product");
  const quantityInput = fragment.querySelector(".line-quantity");
  const priceInput = fragment.querySelector(".line-price");
  const removeButton = fragment.querySelector(".line-remove");

  populateSelect(productSelect, state.inventory, (product) => `${product.name} (${product.sku})`, "Urun secin");
  productSelect.value = item.productId || "";
  quantityInput.value = item.quantity || "";
  priceInput.value = item.price || "";
  line.dataset.lineId = item.id || createId("line");

  removeButton.addEventListener("click", () => {
    line.remove();
    if (!els.orderLines.children.length) {
      addLineItem();
    }
  });

  els.orderLines.appendChild(fragment);
}

function clearOrderForm() {
  if (!hasElement(els.orderForm)) {
    return;
  }

  els.orderForm.reset();
  els.orderIdInput.value = "";
  els.shippingOwnerSelect.value = "Musteri";
  els.orderLines.innerHTML = "";
  addLineItem();
  renderCustomerSnapshot();
  toggleOrderLinesAvailability();
}

function copyOrderIntoForm(orderId) {
  const order = byId(state.orders, orderId);
  const currentUser = getCurrentUser();
  if (!order || currentUser.role !== "sales" || order.repId !== currentUser.id) {
    return;
  }

  els.orderIdInput.value = "";
  els.orderCustomerSelect.value = order.customerId;
  els.deliveryDateInput.value = order.deliveryDate;
  els.paymentTermInput.value = order.paymentTerm || "";
  els.shippingOwnerSelect.value = order.shippingOwner || "Musteri";
  els.orderNoteInput.value = order.note || "";
  els.orderLines.innerHTML = "";
  order.items.forEach((item) => addLineItem({
    productId: item.productId,
    quantity: item.quantity,
    price: item.price
  }));
  renderCustomerSnapshot();
  toggleOrderLinesAvailability();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderSalesOrderCard(order, allowEdit = false) {
  const customer = byId(state.customers, order.customerId);
  const total = getOrdersTotal(order);
  const itemsMarkup = order.items.map((item) => {
    const product = getProduct(item.productId);
    return `<li>${product?.name || "Urun"} - ${item.quantity} x ${formatMoney(item.price)}</li>`;
  }).join("");

  return `
    <article class="order-card">
      <div class="sales-order-summary">
        <div class="sales-order-summary-main">
          <p><strong>Siparis No:</strong> #${order.orderNumber || "-"} <span class="tag ${getOrderTagClass(order)} inline-status-tag">${getOrderStatusLabel(order)}</span></p>
          <strong>${customer?.name || "Musteri silinmis"}</strong>
          <p>${formatDate(order.deliveryDate)}</p>
        </div>
        <div class="button-row sales-order-actions">
          <button class="ghost-button" type="button" data-sales-order-toggle="${order.id}">Ayrintiyi ac</button>
          ${allowEdit ? `<button type="button" data-order-edit="${order.id}">Duzenle</button>` : ""}
          <button class="ghost-button" type="button" data-order-copy="${order.id}">Kopyala</button>
          ${order.reviewStatus === "reviewed" ? `<button class="ghost-button" type="button" data-order-export="${order.id}">Excele aktar</button>` : ""}
          ${order.reviewStatus === "rejected" ? `<button class="danger-button" type="button" data-order-delete="${order.id}">Sil</button>` : ""}
        </div>
      </div>
      <div class="sales-order-details hidden" data-sales-order-details="${order.id}">
        <div class="order-card-total">
          <strong>${formatMoney(total)}</strong>
        </div>
        <p><strong>Durum:</strong> ${getOrderStatusLabel(order)}</p>
        <p><strong>Vade:</strong> ${order.paymentTerm || "-"}</p>
        <p><strong>Nakliye:</strong> ${order.shippingOwner || "-"}</p>
        <ul>${itemsMarkup}</ul>
        <p><strong>Not:</strong> ${order.note || "-"}</p>
        ${renderErpLineDetails(order)}
      </div>
    </article>
  `;
}

function bindSalesOrderActions(container) {
  if (!container) {
    return;
  }

  container.querySelectorAll("[data-sales-order-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleSalesOrderDetails(button.dataset.salesOrderToggle));
  });
  container.querySelectorAll("[data-order-edit]").forEach((button) => {
    button.addEventListener("click", () => loadOrderIntoForm(button.dataset.orderEdit));
  });
  container.querySelectorAll("[data-order-copy]").forEach((button) => {
    button.addEventListener("click", () => copyOrderIntoForm(button.dataset.orderCopy));
  });
  container.querySelectorAll("[data-order-export]").forEach((button) => {
    button.addEventListener("click", () => exportOrderExcel(button.dataset.orderExport));
  });
  container.querySelectorAll("[data-order-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteOrder(button.dataset.orderDelete));
  });
}

function renderOrdersList() {
  const currentUser = getCurrentUser();
  const visibleOrders = getVisibleOrders(currentUser)
    .filter((order) => customerMatchesSearch(byId(state.customers, order.customerId)?.name || "", salesOrdersSearch))
    .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  const pendingOrders = visibleOrders.filter((order) => order.reviewStatus === "pending" || order.reviewStatus === "rejected");
  const reviewedOrders = visibleOrders.filter((order) => order.reviewStatus === "reviewed");

  if (!hasElement(els.salesPendingOrdersList) || !hasElement(els.salesReviewedOrdersList)) {
    return;
  }

  els.salesPendingOrdersList.innerHTML = pendingOrders.length
    ? pendingOrders.map((order) => renderSalesOrderCard(order, true)).join("")
    : `<div class="info-card muted-card">Onay bekleyen siparis yok.</div>`;

  els.salesReviewedOrdersList.innerHTML = reviewedOrders.length
    ? reviewedOrders.map((order) => renderSalesOrderCard(order, true)).join("")
    : `<div class="info-card muted-card">Henuz onaylanan siparis yok.</div>`;

  bindSalesOrderActions(els.salesPendingOrdersList);
  bindSalesOrderActions(els.salesReviewedOrdersList);
}

function toggleSalesOrderDetails(orderId) {
  const details = document.querySelector(`[data-sales-order-details="${orderId}"]`);
  const button = document.querySelector(`[data-sales-order-toggle="${orderId}"]`);
  if (!details || !button) {
    return;
  }

  const expanded = !details.classList.contains("hidden");
  details.classList.toggle("hidden", expanded);
  button.textContent = expanded ? "Ayrintiyi ac" : "Kucult";
}

function renderAdminOrdersList() {
  if (!hasElement(els.adminPendingOrdersList) || !hasElement(els.adminReviewedOrdersList)) {
    return;
  }

  const orders = [...state.orders].sort((left, right) => new Date(right.submittedAt || right.updatedAt) - new Date(left.submittedAt || left.updatedAt));
  const pendingOrders = orders.filter((order) => order.reviewStatus === "pending");
  const reviewedOrders = orders
    .filter((order) => order.reviewStatus !== "pending")
    .filter((order) => customerMatchesSearch(byId(state.customers, order.customerId)?.name || "", adminReviewedSearch));

  els.adminPendingOrdersList.innerHTML = pendingOrders.length
    ? pendingOrders.map((order) => renderAdminOrderCard(order, true)).join("")
    : `<div class="info-card muted-card">Yeni veya revize bekleyen siparis yok.</div>`;

  els.adminReviewedOrdersList.innerHTML = reviewedOrders.length
    ? reviewedOrders.map((order) => renderAdminOrderCard(order, false)).join("")
    : `<div class="info-card muted-card">Henuz onaylanan siparis yok.</div>`;

  els.adminPendingOrdersList.querySelectorAll("[data-order-approve]").forEach((button) => {
    button.addEventListener("click", () => approveOrder(button.dataset.orderApprove));
  });
  els.adminPendingOrdersList.querySelectorAll("[data-order-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleAdminOrderDetails(button.dataset.orderToggle));
  });
  els.adminPendingOrdersList.querySelectorAll("[data-order-reject]").forEach((button) => {
    button.addEventListener("click", () => rejectOrder(button.dataset.orderReject));
  });
  els.adminPendingOrdersList.querySelectorAll("[data-order-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteOrder(button.dataset.orderDelete));
  });
  els.adminReviewedOrdersList.querySelectorAll("[data-order-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleAdminOrderDetails(button.dataset.orderToggle));
  });
  els.adminReviewedOrdersList.querySelectorAll("[data-order-export]").forEach((button) => {
    button.addEventListener("click", () => exportOrderExcel(button.dataset.orderExport));
  });
  els.adminReviewedOrdersList.querySelectorAll("[data-order-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteOrder(button.dataset.orderDelete));
  });
}

function toggleAdminOrderDetails(orderId) {
  const details = document.querySelector(`[data-order-details="${orderId}"]`);
  const button = document.querySelector(`[data-order-toggle="${orderId}"]`);
  if (!details || !button) {
    return;
  }

  const expanded = !details.classList.contains("hidden");
  details.classList.toggle("hidden", expanded);
  button.textContent = expanded ? "Ayrintiyi ac" : "Kucult";
}

function exportOrderExcel(orderId) {
  window.location.href = `./api/orders/${encodeURIComponent(orderId)}/export`;
}

function renderAdminOrderCard(order, canApprove) {
  const customer = byId(state.customers, order.customerId);
  const rep = byId(state.users, order.repId);
  const dealer = customer ? getDealerForCustomer(customer) : null;
  const statusClass = getOrderTagClass(order);
  const totalKg = getOrderTotalKg(order);
  const revisionBadge = order.submissionLabel === "Revize" ? `<span class="tag tag-danger">Revize</span>` : "";

  return `
    <article class="order-card">
      <div class="admin-order-summary">
        <div class="admin-order-summary-main">
          <strong>${rep?.name || "-"} <span class="tag ${statusClass} inline-status-tag">${getOrderStatusLabel(order)}</span></strong>
          <span>${customer?.name || "Musteri silinmis"}</span>
          <span>#${order.orderNumber || "-"} - ${formatKg(totalKg)} kg</span>
          ${revisionBadge}
        </div>
        <div class="button-row admin-order-actions">
          <button class="ghost-button" type="button" data-order-toggle="${order.id}">Ayrintiyi ac</button>
          ${canApprove ? `<button type="button" data-order-approve="${order.id}">Onayla</button>` : `<span class="tag">Islem tamamlandi</span>`}
          ${canApprove ? `<button class="danger-button" type="button" data-order-reject="${order.id}">Reddet</button>` : ""}
          ${!canApprove ? `<button class="ghost-button" type="button" data-order-export="${order.id}">Excele aktar</button>` : ""}
          <button class="danger-button" type="button" data-order-delete="${order.id}">Sil</button>
        </div>
      </div>
      <div class="admin-order-details hidden" data-order-details="${order.id}">
        <div class="order-card-top">
          <span class="tag ${statusClass}">${getOrderStatusLabel(order)}</span>
          <span class="tag">${formatMoney(getOrdersTotal(order))}</span>
        </div>
        <div class="admin-order-grid">
          <p><strong>Siparis No:</strong> #${order.orderNumber || "-"}</p>
          <p><strong>Musteri:</strong> ${customer?.name || "-"}</p>
          <p><strong>Bayi:</strong> ${dealer?.name || "-"}</p>
          <p><strong>Satici:</strong> ${rep?.name || "-"}</p>
          <p><strong>Firma:</strong> ${getCompanyName(order.companyId)}</p>
          <p><strong>Teslim:</strong> ${formatDate(order.deliveryDate)}</p>
          <p><strong>Vade:</strong> ${order.paymentTerm || "-"}</p>
          <p><strong>Nakliye:</strong> ${order.shippingOwner || "-"}</p>
          <p><strong>Toplam tonaj:</strong> ${formatKg(totalKg)} kg</p>
          <p><strong>Kalem:</strong> ${order.items.length}</p>
          <p><strong>Girilme:</strong> ${formatDateTime(order.submittedAt)}</p>
          <p><strong>Kontrol:</strong> ${order.reviewStatus === "reviewed" ? formatDateTime(order.reviewedAt) : "Bekliyor"}</p>
        </div>
        ${renderRevisionSummary(order)}
        <div class="admin-order-section">
          <h4>Siparis notu</h4>
          <p>${order.note || "-"}</p>
        </div>
        ${renderOrderItemsDetails(order)}
        ${renderErpLineDetails(order)}
      </div>
    </article>
  `;
}

async function approveOrder(orderId) {
  await apiRequest(`./api/orders/${orderId}/approve`, { method: "POST" });
  await refreshState();
  renderAll();
}

async function rejectOrder(orderId) {
  await apiRequest(`./api/orders/${orderId}/reject`, { method: "POST" });
  await refreshState();
  renderAll();
}

async function deleteOrder(orderId) {
  await apiRequest(`./api/orders/${orderId}`, getDeleteRequestOptions());
  await refreshState();
  if (hasElement(els.orderIdInput) && els.orderIdInput.value === orderId) {
    clearOrderForm();
  }
  renderAll();
}

function loadOrderIntoForm(orderId) {
  const order = byId(state.orders, orderId);
  const currentUser = getCurrentUser();
  if (!order || (currentUser.role !== "admin" && order.repId !== currentUser.id)) {
    return;
  }

  els.orderIdInput.value = order.id;
  els.orderCustomerSelect.value = order.customerId;
  els.deliveryDateInput.value = order.deliveryDate;
  els.paymentTermInput.value = order.paymentTerm || "";
  els.shippingOwnerSelect.value = order.shippingOwner || "Musteri";
  els.orderNoteInput.value = order.note || "";
  els.orderLines.innerHTML = "";
  order.items.forEach((item) => addLineItem(item));
  renderCustomerSnapshot();
  toggleOrderLinesAvailability();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function collectOrderItems() {
  const items = Array.from(els.orderLines.querySelectorAll(".line-item")).map((line) => {
    const productId = line.querySelector(".line-product").value;
    const quantity = Number(line.querySelector(".line-quantity").value);
    const price = Number(line.querySelector(".line-price").value);

    if (!productId || !quantity || quantity < 1 || Number.isNaN(price) || price < 0) {
      return null;
    }

    return {
      id: line.dataset.lineId,
      productId,
      quantity,
      price
    };
  }).filter(Boolean);

  return items;
}

async function handleCustomerCreate(event) {
  event.preventDefault();
  const formData = new FormData(els.customerForm);
  const name = formData.get("customerName")?.toString().trim();
  const erpCode = formData.get("erpCode")?.toString().trim();
  const repId = formData.get("repId")?.toString();
  const dealerId = formData.get("dealerId")?.toString();
  const companyId = formData.get("companyId")?.toString();

  if (!name || !repId || !dealerId || !companyId) {
    return;
  }

  await apiRequest("./api/customers", {
    method: "POST",
    body: JSON.stringify({ name, erpCode, repId, dealerId, companyId })
  });

  await refreshState();
  els.customerForm.reset();
  renderAll();
}

async function handleAssignmentUpdate(event) {
  event.preventDefault();
  const customer = byId(state.customers, els.assignmentCustomerSelect.value);
  const repId = els.assignmentRepSelect.value;
  const erpCode = els.assignmentCustomerErpCodeInput.value.trim();
  if (!customer || !repId) {
    return;
  }

  await apiRequest(`./api/customers/${customer.id}/assignment`, {
    method: "PUT",
    body: JSON.stringify({ repId, erpCode })
  });

  lastAssignmentCustomerId = customer.id;
  await refreshState();
  renderAll();
}

async function handleBulkTransfer(event) {
  event.preventDefault();
  const fromRepId = els.bulkTransferSourceRepSelect.value;
  const toRepId = els.bulkTransferTargetRepSelect.value;
  if (!fromRepId || !toRepId || fromRepId === toRepId) {
    return;
  }

  await apiRequest("./api/customers/bulk-transfer", {
    method: "POST",
    body: JSON.stringify({ fromRepId, toRepId })
  });

  await refreshState();
  syncBulkTransferSummary();
  renderAll();
}

async function handleCustomerRemove() {
  const customerId = els.assignmentCustomerSelect.value;
  if (!customerId) {
    return;
  }

  await apiRequest(`./api/customers/${customerId}`, getDeleteRequestOptions());
  await refreshState();
  renderAll();
}

async function handleSalesRepCreate(event) {
  event.preventDefault();
  const formData = new FormData(els.salesRepForm);
  const payload = {
    name: formData.get("name")?.toString().trim(),
    username: formData.get("username")?.toString().trim().toLowerCase(),
    salesmanCode: formData.get("salesmanCode")?.toString().trim().toUpperCase(),
    password: formData.get("password")?.toString().trim(),
    region: formData.get("region")?.toString().trim(),
    companyId: formData.get("companyId")?.toString()
  };

  if (!payload.name || !payload.username || !payload.password || !payload.region || !payload.companyId) {
    return;
  }

  await apiRequest("./api/sales-reps", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  await refreshState();
  els.salesRepForm.reset();
  renderAll();
}

async function handleSalesRepUpdate(event) {
  event.preventDefault();
  const repId = els.salesRepEditSelect.value;
  const payload = {
    name: els.salesRepEditNameInput.value.trim(),
    username: els.salesRepEditUsernameInput.value.trim().toLowerCase(),
    salesmanCode: els.salesRepEditCodeInput.value.trim().toUpperCase(),
    password: els.salesRepEditPasswordInput.value.trim(),
    region: els.salesRepEditRegionInput.value.trim(),
    companyId: els.salesRepEditCompanySelect.value
  };

  if (!repId || !payload.name || !payload.username || !payload.password || !payload.region || !payload.companyId) {
    return;
  }

  await apiRequest(`./api/sales-reps/${repId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });

  await refreshState();
  await loadSalesRepIntoEditForm(repId);
  renderAll();
}

async function handleSalesRepRemove() {
  const repId = els.salesRepDeleteSelect.value;
  if (!repId) {
    return;
  }

  await apiRequest(`./api/sales-reps/${repId}`, getDeleteRequestOptions());
  await refreshState();
  salesRepEditCacheId = "";
  renderAll();
}

async function handleCustomerCodeImport() {
  await apiRequest("./api/customer-codes/import", { method: "POST" });
  await refreshState();
  syncAssignmentCustomerMeta();
  renderAll();
}

async function handleProductCreate(event) {
  event.preventDefault();
  const formData = new FormData(els.productForm);
  const payload = {
    sku: formData.get("sku")?.toString().trim(),
    name: formData.get("name")?.toString().trim(),
    unit: formData.get("unit")?.toString().trim()
  };

  if (!payload.sku || !payload.name) {
    return;
  }

  await apiRequest("./api/products", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  await refreshState();
  els.productForm.reset();
  renderAll();
}

async function handleProductRemove() {
  const productId = els.productDeleteSelect.value;
  if (!productId) {
    return;
  }

  await apiRequest(`./api/products/${productId}`, getDeleteRequestOptions());
  await refreshState();
  renderAll();
}

async function handleOrderSubmit(event) {
  event.preventDefault();
  const currentUser = getCurrentUser();
  if (currentUser.role !== "sales") {
    return;
  }

  const customerId = els.orderCustomerSelect.value;
  const customer = byId(state.customers, customerId);
  const items = collectOrderItems();
  if (!customer || customer.repId !== currentUser.id || !items.length) {
    return;
  }

  const payload = {
    companyId: customer.companyId,
    repId: currentUser.id,
    customerId,
    deliveryDate: els.deliveryDateInput.value,
    paymentTerm: els.paymentTermInput.value.trim(),
    shippingOwner: els.shippingOwnerSelect.value,
    note: els.orderNoteInput.value.trim(),
    items
  };

  if (els.orderIdInput.value) {
    await apiRequest(`./api/orders/${els.orderIdInput.value}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  } else {
    await apiRequest("./api/orders", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  await refreshState();
  clearOrderForm();
  renderAll();
}

function bindEvents() {
  if (hasElement(els.resetDataButton)) {
    els.resetDataButton.addEventListener("click", async () => {
      await apiRequest("./api/reset", { method: "POST" });
      await refreshState();
      clearOrderForm();
      renderAll();
    });
  }

  if (hasElement(els.logoutButton)) {
    els.logoutButton.addEventListener("click", () => {
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(SESSION_KEY);
      window.location.href = "./index.html";
    });
  }

  if (hasElement(els.customerRepSelect)) {
    els.customerRepSelect.addEventListener("change", syncDealerOptions);
  }
  if (hasElement(els.customerForm)) {
    els.customerForm.addEventListener("submit", handleCustomerCreate);
  }
  if (hasElement(els.assignmentForm)) {
    els.assignmentForm.addEventListener("submit", handleAssignmentUpdate);
  }
  if (hasElement(els.assignmentCustomerSelect)) {
    els.assignmentCustomerSelect.addEventListener("change", syncAssignmentCustomerMeta);
  }
  if (hasElement(els.bulkTransferSourceRepSelect)) {
    els.bulkTransferSourceRepSelect.addEventListener("change", syncBulkTransferSummary);
  }
  if (hasElement(els.bulkTransferTargetRepSelect)) {
    els.bulkTransferTargetRepSelect.addEventListener("change", syncBulkTransferSummary);
  }
  if (hasElement(els.bulkTransferForm)) {
    els.bulkTransferForm.addEventListener("submit", handleBulkTransfer);
  }
  if (hasElement(els.removeCustomerButton)) {
    els.removeCustomerButton.addEventListener("click", handleCustomerRemove);
  }
  if (hasElement(els.importCustomerCodesButton)) {
    els.importCustomerCodesButton.addEventListener("click", handleCustomerCodeImport);
  }
  if (hasElement(els.salesRepForm)) {
    els.salesRepForm.addEventListener("submit", handleSalesRepCreate);
  }
  if (hasElement(els.salesRepEditForm)) {
    els.salesRepEditForm.addEventListener("submit", handleSalesRepUpdate);
  }
  if (hasElement(els.salesRepEditSelect)) {
    els.salesRepEditSelect.addEventListener("change", () => {
      salesRepEditCacheId = "";
      if (hasElement(els.salesRepDeleteSelect)) {
        els.salesRepDeleteSelect.value = els.salesRepEditSelect.value;
      }
      loadSalesRepIntoEditForm(els.salesRepEditSelect.value).catch(console.error);
    });
  }
  if (hasElement(els.removeSalesRepButton)) {
    els.removeSalesRepButton.addEventListener("click", handleSalesRepRemove);
  }
  if (hasElement(els.productForm)) {
    els.productForm.addEventListener("submit", handleProductCreate);
  }
  if (hasElement(els.removeProductButton)) {
    els.removeProductButton.addEventListener("click", handleProductRemove);
  }
  if (hasElement(els.orderCustomerSelect)) {
    els.orderCustomerSelect.addEventListener("change", () => {
      renderCustomerSnapshot();
      toggleOrderLinesAvailability();
    });
  }
  if (hasElement(els.adminReviewedSearchInput)) {
    els.adminReviewedSearchInput.addEventListener("input", () => {
      adminReviewedSearch = els.adminReviewedSearchInput.value.trim();
      renderAdminOrdersList();
    });
  }
  if (hasElement(els.salesOrdersSearchInput)) {
    els.salesOrdersSearchInput.addEventListener("input", () => {
      salesOrdersSearch = els.salesOrdersSearchInput.value.trim();
      renderOrdersList();
    });
  }
  if (hasElement(els.addLineButton)) {
    els.addLineButton.addEventListener("click", () => addLineItem());
  }
  if (hasElement(els.clearOrderButton)) {
    els.clearOrderButton.addEventListener("click", clearOrderForm);
  }
  if (hasElement(els.orderForm)) {
    els.orderForm.addEventListener("submit", handleOrderSubmit);
  }
}

function renderSessionMeta() {
  const currentUser = getCurrentUser();
  if (!currentUser || !hasElement(els.sessionUserName)) {
    return;
  }

  const companyName = getCompanyName(currentUser.companyId);
  els.sessionUserName.textContent = `${currentUser.name} (${currentUser.role === "admin" ? "Admin" : "Satici"})`;
  if (hasElement(els.sessionMeta)) {
    els.sessionMeta.textContent = currentUser.role === "admin"
      ? `${companyName} - tum bolgeler ve tum saticilar`
      : `${companyName} - ${currentUser.region} bolgesi`;
  }
}

function renderAll() {
  if (!getCurrentUser()) {
    window.location.href = "./index.html";
    return;
  }

  renderSessionMeta();
  renderMetrics();
  renderAdminPanel();
  renderDeletedRecordsPage();
  renderSalesPanel();
}

if (!currentUserId) {
  window.location.href = "./index.html";
}

async function initializeApp() {
  hydrateElements();
  bindEvents();

  if (!currentUserId) {
    window.location.href = "./index.html";
    return;
  }

  await refreshState();

  if (!getCurrentUser()) {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(SESSION_KEY);
    window.location.href = "./index.html";
    return;
  }

  clearOrderForm();
  renderAll();
}

initializeApp().catch((error) => {
  console.error(error);
});
