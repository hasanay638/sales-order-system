const STORAGE_KEY = "sales-order-system-state";
const SESSION_KEY = "sales-order-system-user";
const AUTH_KEY = "sales-order-system-auth";

const seedState = {
  companies: [
    { id: "company-akdeniz", name: "Akdeniz Gida" },
    { id: "company-marmara", name: "Marmara Dagitim" }
  ],
  users: [
    { id: "admin-1", name: "Merkez Admin", username: "admin", role: "admin", companyId: "company-akdeniz", region: "Tum Bolgeler" },
    { id: "rep-1", name: "Ayse Demir", username: "ayse", role: "sales", companyId: "company-akdeniz", region: "Ege" },
    { id: "rep-2", name: "Mehmet Kaya", username: "mehmet", role: "sales", companyId: "company-akdeniz", region: "Ic Anadolu" },
    { id: "rep-3", name: "Elif Acar", username: "elif", role: "sales", companyId: "company-marmara", region: "Marmara" }
  ],
  dealers: [
    { id: "dealer-1", name: "Izmir Kuzey Bayi", companyId: "company-akdeniz", repId: "rep-1" },
    { id: "dealer-2", name: "Manisa Merkez Bayi", companyId: "company-akdeniz", repId: "rep-1" },
    { id: "dealer-3", name: "Ankara Batikent Bayi", companyId: "company-akdeniz", repId: "rep-2" },
    { id: "dealer-4", name: "Bursa Nilufer Bayi", companyId: "company-marmara", repId: "rep-3" }
  ],
  customers: [
    { id: "customer-1", name: "Ege Tavukculuk", companyId: "company-akdeniz", dealerId: "dealer-1", repId: "rep-1" },
    { id: "customer-2", name: "Yesilova Ciftlik", companyId: "company-akdeniz", dealerId: "dealer-2", repId: "rep-1" },
    { id: "customer-3", name: "Basak Yem", companyId: "company-akdeniz", dealerId: "dealer-3", repId: "rep-2" },
    { id: "customer-4", name: "Uludag Satis Noktasi", companyId: "company-marmara", dealerId: "dealer-4", repId: "rep-3" }
  ],
  inventory: [
    { id: "product-1", name: "Yem 50 kg", sku: "YEM-50", unit: "cuval" },
    { id: "product-2", name: "Yem 25 kg", sku: "YEM-25", unit: "cuval" },
    { id: "product-3", name: "Vitamin Katkisi", sku: "VIT-10", unit: "koli" },
    { id: "product-4", name: "Misir Kirma", sku: "MIS-01", unit: "ton" }
  ],
  orders: [
    {
      id: "order-1",
      companyId: "company-akdeniz",
      repId: "rep-1",
      customerId: "customer-1",
      deliveryDate: "2026-04-04",
      note: "Sabah sevkiyat tercih ediliyor.",
      createdAt: "2026-03-30T09:00:00",
      updatedAt: "2026-03-30T09:00:00",
      items: [
        { id: "line-1", productId: "product-1", quantity: 25, price: 840 },
        { id: "line-2", productId: "product-3", quantity: 4, price: 320 }
      ]
    }
  ]
};

const els = {};
let state = loadState();
let currentUserId = loadSessionUserId();

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return structuredClone(seedState);
  }

  try {
    const parsed = JSON.parse(raw);
    return { ...structuredClone(seedState), ...parsed };
  } catch (error) {
    return structuredClone(seedState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadSessionUserId() {
  const isAuthenticated = localStorage.getItem(AUTH_KEY) === "true";
  const stored = localStorage.getItem(SESSION_KEY);
  if (isAuthenticated && stored && seedState.users.some((user) => user.id === stored)) {
    return stored;
  }

  return null;
}

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

function formatMoney(value) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(new Date(value));
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function hydrateElements() {
  els.sessionUserName = document.getElementById("sessionUserName");
  els.sessionMeta = document.getElementById("sessionMeta");
  els.resetDataButton = document.getElementById("resetDataButton");
  els.logoutButton = document.getElementById("logoutButton");
  els.metricsGrid = document.getElementById("metricsGrid");
  els.adminPanel = document.getElementById("adminPanel");
  els.salesPanel = document.getElementById("salesPanel");
  els.customerForm = document.getElementById("customerForm");
  els.customerCompanySelect = document.getElementById("customerCompanySelect");
  els.customerDealerSelect = document.getElementById("customerDealerSelect");
  els.customerRepSelect = document.getElementById("customerRepSelect");
  els.assignmentForm = document.getElementById("assignmentForm");
  els.assignmentCustomerSelect = document.getElementById("assignmentCustomerSelect");
  els.assignmentRepSelect = document.getElementById("assignmentRepSelect");
  els.removeCustomerButton = document.getElementById("removeCustomerButton");
  els.customerTable = document.getElementById("customerTable");
  els.adminOrdersList = document.getElementById("adminOrdersList");
  els.salesScopeTag = document.getElementById("salesScopeTag");
  els.orderForm = document.getElementById("orderForm");
  els.orderIdInput = document.getElementById("orderIdInput");
  els.orderCustomerSelect = document.getElementById("orderCustomerSelect");
  els.customerSnapshot = document.getElementById("customerSnapshot");
  els.orderLines = document.getElementById("orderLines");
  els.lineItemTemplate = document.getElementById("lineItemTemplate");
  els.addLineButton = document.getElementById("addLineButton");
  els.deliveryDateInput = document.getElementById("deliveryDateInput");
  els.orderNoteInput = document.getElementById("orderNoteInput");
  els.clearOrderButton = document.getElementById("clearOrderButton");
  els.ordersList = document.getElementById("ordersList");
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
  const currentUser = getCurrentUser();
  const visibleCustomers = getVisibleCustomers(currentUser);
  const visibleOrders = getVisibleOrders(currentUser);
  const visibleDealers = currentUser.role === "admin"
    ? state.dealers
    : state.dealers.filter((dealer) => dealer.repId === currentUser.id);
  const totalRevenue = visibleOrders.reduce((sum, order) => sum + getOrdersTotal(order), 0);

  const cards = [
    { label: currentUser.role === "admin" ? "Toplam satici" : "Bagli bayi", value: currentUser.role === "admin" ? getRepUsers().length : visibleDealers.length },
    { label: "Gorunen musteri", value: visibleCustomers.length },
    { label: "Siparis sayisi", value: visibleOrders.length },
    { label: "Toplam ciro", value: formatMoney(totalRevenue) }
  ];

  els.metricsGrid.innerHTML = cards.map((card) => `
    <article class="metric-card">
      <span class="eyebrow">${card.label}</span>
      <strong>${card.value}</strong>
    </article>
  `).join("");
}

function renderAdminPanel() {
  const currentUser = getCurrentUser();
  const showAdmin = currentUser.role === "admin";
  els.adminPanel.classList.toggle("hidden", !showAdmin);

  if (!showAdmin) {
    return;
  }

  populateSelect(els.customerCompanySelect, state.companies, (company) => company.name, null);
  populateSelect(els.customerRepSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.region}`, null);
  populateSelect(els.assignmentRepSelect, getRepUsers(), (rep) => `${rep.name} - ${rep.region}`, null);
  populateSelect(els.assignmentCustomerSelect, state.customers, (customer) => customer.name, null);

  syncDealerOptions();
  if (!els.assignmentRepSelect.value && getRepUsers()[0]) {
    els.assignmentRepSelect.value = getRepUsers()[0].id;
  }

  els.customerTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Musteri</th>
          <th>Firma</th>
          <th>Bayi</th>
          <th>Satici</th>
          <th>Bolge</th>
        </tr>
      </thead>
      <tbody>
        ${state.customers.map((customer) => {
          const dealer = getDealerForCustomer(customer);
          const rep = byId(state.users, customer.repId);
          return `
            <tr>
              <td>${customer.name}</td>
              <td>${getCompanyName(customer.companyId)}</td>
              <td>${dealer?.name || "-"}</td>
              <td>${rep?.name || "-"}</td>
              <td>${rep?.region || "-"}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  renderAdminOrdersList();
}

function syncDealerOptions() {
  const selectedRepId = els.customerRepSelect.value || getRepUsers()[0]?.id;
  const repDealers = state.dealers.filter((dealer) => dealer.repId === selectedRepId);
  populateSelect(els.customerDealerSelect, repDealers, (dealer) => dealer.name, null);
}

function renderSalesPanel() {
  const currentUser = getCurrentUser();
  const showSales = currentUser.role === "sales";
  els.salesPanel.classList.toggle("hidden", !showSales);

  if (!showSales) {
    return;
  }

  const visibleCustomers = getVisibleCustomers(currentUser);
  populateSelect(els.orderCustomerSelect, visibleCustomers, (customer) => customer.name, "Musteri secin");
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
  els.orderForm.reset();
  els.orderIdInput.value = "";
  els.orderLines.innerHTML = "";
  addLineItem();
  renderCustomerSnapshot();
  toggleOrderLinesAvailability();
}

function renderOrdersList() {
  const currentUser = getCurrentUser();
  const visibleOrders = getVisibleOrders(currentUser).sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));

  if (!visibleOrders.length) {
    els.ordersList.innerHTML = `<div class="info-card muted-card">Henuz siparis yok.</div>`;
    return;
  }

  els.ordersList.innerHTML = visibleOrders.map((order) => {
    const customer = byId(state.customers, order.customerId);
    const total = getOrdersTotal(order);
    const itemsMarkup = order.items.map((item) => {
      const product = getProduct(item.productId);
      return `<li>${product?.name || "Urun"} - ${item.quantity} x ${formatMoney(item.price)}</li>`;
    }).join("");

    return `
      <article class="order-card">
        <div class="order-card-top">
          <div>
            <strong>${customer?.name || "Musteri silinmis"}</strong>
            <p>${formatDate(order.deliveryDate)}</p>
          </div>
          <button type="button" data-order-edit="${order.id}">Duzenle</button>
        </div>
        <div class="order-card-total">
          <span>${order.items.length} kalem</span>
          <strong>${formatMoney(total)}</strong>
        </div>
        <ul>${itemsMarkup}</ul>
        <p><strong>Not:</strong> ${order.note || "-"}</p>
      </article>
    `;
  }).join("");

  els.ordersList.querySelectorAll("[data-order-edit]").forEach((button) => {
    button.addEventListener("click", () => loadOrderIntoForm(button.dataset.orderEdit));
  });
}

function renderAdminOrdersList() {
  const orders = [...state.orders].sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));

  if (!orders.length) {
    els.adminOrdersList.innerHTML = `<div class="info-card muted-card">Henuz siparis kaydi yok.</div>`;
    return;
  }

  els.adminOrdersList.innerHTML = orders.map((order) => {
    const customer = byId(state.customers, order.customerId);
    const rep = byId(state.users, order.repId);
    return `
      <article class="order-card">
        <div class="order-card-top">
          <div>
            <strong>${customer?.name || "Musteri silinmis"}</strong>
            <p>${getCompanyName(order.companyId)} - ${rep?.name || "-"}</p>
          </div>
          <span class="tag">${formatMoney(getOrdersTotal(order))}</span>
        </div>
        <p>Teslim: ${formatDate(order.deliveryDate)}</p>
        <p>Kalem: ${order.items.length}</p>
        <p>Not: ${order.note || "-"}</p>
      </article>
    `;
  }).join("");
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

function handleCustomerCreate(event) {
  event.preventDefault();
  const formData = new FormData(els.customerForm);
  const name = formData.get("customerName")?.toString().trim();
  const repId = formData.get("repId")?.toString();
  const dealerId = formData.get("dealerId")?.toString();
  const companyId = formData.get("companyId")?.toString();

  if (!name || !repId || !dealerId || !companyId) {
    return;
  }

  state.customers.push({
    id: createId("customer"),
    name,
    repId,
    dealerId,
    companyId
  });

  saveState();
  els.customerForm.reset();
  renderAll();
}

function handleAssignmentUpdate(event) {
  event.preventDefault();
  const customer = byId(state.customers, els.assignmentCustomerSelect.value);
  const repId = els.assignmentRepSelect.value;
  if (!customer || !repId) {
    return;
  }

  const repDealers = state.dealers.filter((dealer) => dealer.repId === repId);
  customer.repId = repId;
  if (!repDealers.some((dealer) => dealer.id === customer.dealerId) && repDealers[0]) {
    customer.dealerId = repDealers[0].id;
  }
  saveState();
  renderAll();
}

function handleCustomerRemove() {
  const customerId = els.assignmentCustomerSelect.value;
  if (!customerId) {
    return;
  }

  state.customers = state.customers.filter((customer) => customer.id !== customerId);
  state.orders = state.orders.filter((order) => order.customerId !== customerId);
  saveState();
  renderAll();
}

function handleOrderSubmit(event) {
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
    note: els.orderNoteInput.value.trim(),
    items,
    updatedAt: new Date().toISOString()
  };

  if (els.orderIdInput.value) {
    const existing = byId(state.orders, els.orderIdInput.value);
    if (!existing || existing.repId !== currentUser.id) {
      return;
    }

    Object.assign(existing, payload);
  } else {
    state.orders.push({
      id: createId("order"),
      createdAt: new Date().toISOString(),
      ...payload
    });
  }

  saveState();
  clearOrderForm();
  renderAll();
}

function bindEvents() {
  els.resetDataButton.addEventListener("click", () => {
    state = structuredClone(seedState);
    saveState();
    saveSessionUserId(currentUserId || "admin-1");
    clearOrderForm();
    renderAll();
  });

  els.logoutButton.addEventListener("click", () => {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(SESSION_KEY);
    window.location.href = "./index.html";
  });

  els.customerRepSelect.addEventListener("change", syncDealerOptions);
  els.customerForm.addEventListener("submit", handleCustomerCreate);
  els.assignmentForm.addEventListener("submit", handleAssignmentUpdate);
  els.removeCustomerButton.addEventListener("click", handleCustomerRemove);
  els.orderCustomerSelect.addEventListener("change", () => {
    renderCustomerSnapshot();
    toggleOrderLinesAvailability();
  });
  els.addLineButton.addEventListener("click", () => addLineItem());
  els.clearOrderButton.addEventListener("click", clearOrderForm);
  els.orderForm.addEventListener("submit", handleOrderSubmit);
}

function renderSessionMeta() {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    return;
  }

  const companyName = getCompanyName(currentUser.companyId);
  els.sessionUserName.textContent = `${currentUser.name} (${currentUser.role === "admin" ? "Admin" : "Satici"})`;
  els.sessionMeta.textContent = currentUser.role === "admin"
    ? `${companyName} - tum bolgeler ve tum saticilar`
    : `${companyName} - ${currentUser.region} bolgesi`;
}

function renderAll() {
  if (!getCurrentUser()) {
    window.location.href = "./index.html";
    return;
  }

  renderSessionMeta();
  renderMetrics();
  renderAdminPanel();
  renderSalesPanel();
}

if (!currentUserId) {
  window.location.href = "./index.html";
}

hydrateElements();
bindEvents();
clearOrderForm();
renderAll();
