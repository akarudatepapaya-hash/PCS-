// ============================================================
// PCS ACCOUNTING SYSTEM — app.js
// Phase 1 : QO / Term / Slip / Timestamp
// Phase 2 : KBIZ CSV upload + auto-match
// Phase 3 : Revenue / Profit per Shipment
// Phase 4 : Real field alignment (SEA/AIR/TRUCK/CARGO sheets)
//           + Realtime polling (Supabase)
//           + Google Sheets → Supabase push (Apps Script bridge)
//           + transfer_status / receipt_status / withholding_no
//           + container_flight_no field
// ============================================================

const SUPABASE_URL = "https://bavthrpwpmgxrobqgytp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhdnRocnB3cG1neHJvYnFneXRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MDYwNzcsImV4cCI6MjA5MTM4MjA3N30.DUa_f8gjPC2rRJq_je1VCNR8RIqnk_gkTfnc_SGbAgg";

// ============================================================
// Supabase REST helper
// ============================================================
const sb = {
  headers: {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    "Prefer": "return=representation"
  },

  async select(table, query = "") {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { ...sb.headers, "Prefer": "return=representation" }
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async insert(table, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: sb.headers,
      body: JSON.stringify(Array.isArray(data) ? data : [data])
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async update(table, data, match) {
    const params = Object.entries(match).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join("&");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      method: "PATCH",
      headers: sb.headers,
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async delete(table, match) {
    const params = Object.entries(match).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join("&");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      method: "DELETE",
      headers: { ...sb.headers, "Prefer": "return=minimal" }
    });
    if (!res.ok) throw new Error(await res.text());
  },

  async upsert(table, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...sb.headers, "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(Array.isArray(data) ? data : [data])
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
};

// ============================================================
// App State
// ============================================================
const appState = {
  currentUser: null,
  selectedShipmentId: null,
  activePage: "dashboard-page",
  serviceCosts: [],
  expenseMaster: [],
  banks: [],
  taxRules: [],
  users: [],
  expenseRequests: [],   // mode=cargo
  freightShipments: [],
  freightItems: [],      // mode=freight (SEA/AIR/TRUCK)
  statementRows: [],
  revenues: [],
  logs: [],
  pendingSlipFile: null,
  pendingFreightSlipFile: null,
  realtimeTimer: null    // Phase 4: polling timer
};

// ============================================================
// MASTER DATA — หมวดหมู่ / รายการเบิกจาก Excel จริง
// ============================================================
const EXPENSE_MASTER_SEED = [
  // ต้นทุนบริการ — ตรงชีท SEA/AIR/TRUCK
  { category:"ต้นทุนบริการ", item:"ค่าเฟรท", topic:"ค่าระวางสินค้า", need_receipt:false, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"ต้นทุนบริการ", item:"ค่าท่า / Terminal", topic:"ค่าบริการท่าเรือ / สนามบิน", need_receipt:true, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"ต้นทุนบริการ", item:"ค่ารถหัวลาก", topic:"ค่าขนส่งทางรถ", need_receipt:true, need_slip:true, need_withholding:true, withholding_pct:1 },
  { category:"ต้นทุนบริการ", item:"ค่าชิปปิ้ง / เคลียร์เจ้าหน้าที่", topic:"ค่าพิธีการศุลกากร", need_receipt:true, need_slip:true, need_withholding:true, withholding_pct:3 },
  { category:"ต้นทุนบริการ", item:"ค่าลงทะเบียน + จับคู่ YY", topic:"ค่าบริการด้านพิธีการศุลกากร", need_receipt:false, need_slip:true, need_withholding:true, withholding_pct:3 },
  { category:"ต้นทุนบริการ", item:"ค่าบริการด้านพิธีการศุลกากร (1)", topic:"ค่าชิปปิ้ง", need_receipt:false, need_slip:true, need_withholding:true, withholding_pct:3 },
  { category:"ต้นทุนบริการ", item:"ค่ารถขนส่ง 4 ล้อ", topic:"ค่าขนส่ง 4 ล้อ", need_receipt:true, need_slip:true, need_withholding:true, withholding_pct:1 },
  { category:"ต้นทุนบริการ", item:"ค่ารถขนส่ง 6 ล้อ", topic:"ค่าขนส่ง 6 ล้อ", need_receipt:true, need_slip:true, need_withholding:true, withholding_pct:1 },
  { category:"ต้นทุนบริการ", item:"ค่ารถหัวลาก 18 ล้อ", topic:"ค่าขนส่งหัวลาก 18 ล้อ", need_receipt:true, need_slip:true, need_withholding:true, withholding_pct:1 },
  { category:"ต้นทุนบริการ", item:"ค่าชิปปิ้งเหมารวม", topic:"ค่าชิปปิ้ง + ขนส่งรวม", need_receipt:true, need_slip:true, need_withholding:true, withholding_pct:3 },
  { category:"ต้นทุนบริการ", item:"ค่าแมสเซนเจอร์", topic:"ค่าวิ่งเอกสาร", need_receipt:true, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"ต้นทุนบริการ", item:"ค่า D/O", topic:"ค่าแลก D/O สายเรือ", need_receipt:true, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"ต้นทุนบริการ", item:"ขอคืนภาษีโกดังจีน", topic:"ภาษีคืนโกดังจีน CNY", need_receipt:false, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"ต้นทุนบริการ", item:"ค่าดำเนินการอื่นๆ", topic:"ค่าใช้จ่ายอื่น", need_receipt:true, need_slip:true, need_withholding:false, withholding_pct:0 },
  // เบิกเงินค่าสินค้า
  { category:"เบิกเงินค่าสินค้า", item:"เบิกเงินค่าสินค้า (Alipay)", topic:"ฝากจ่ายค่าสินค้าผ่าน Alipay", need_receipt:false, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"เบิกเงินค่าสินค้า", item:"เบิกเงินค่าสินค้า (โอนตรง)", topic:"ฝากจ่ายค่าสินค้าโอนตรง", need_receipt:true, need_slip:true, need_withholding:false, withholding_pct:0 },
  // เบิก/คืนเงิน
  { category:"เบิก/คืนเงิน และอื่นๆ", item:"เบิกเงินคืนลูกค้า", topic:"คืนเงินลูกค้าที่โอนมาเกิน", need_receipt:false, need_slip:false, need_withholding:false, withholding_pct:0 },
  { category:"เบิก/คืนเงิน และอื่นๆ", item:"เบิกเงินทดรองจ่าย", topic:"เงินทดรองจ่ายทั่วไป", need_receipt:true, need_slip:false, need_withholding:false, withholding_pct:0 },
  // ค่าใช้จ่ายทั่วไป
  { category:"ค่าใช้จ่ายบุคลากร", item:"ค่าส่งไปรษณีย์", topic:"ค่าส่งเอกสารไปรษณีย์", need_receipt:true, need_slip:false, need_withholding:false, withholding_pct:0 },
  { category:"ค่าใช้จ่ายบุคลากร", item:"เงินเดือน / ค่าจ้าง", topic:"เงินเดือนพนักงาน", need_receipt:false, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"ค่าใช้จ่ายบุคลากร", item:"ค่าคอมมิชชั่น Sales", topic:"ค่าคอมมิชชั่น 1%/5%", need_receipt:false, need_slip:true, need_withholding:true, withholding_pct:3 },
  // ตั๋วชน
  { category:"ตั๋วชนทางแอร์", item:"ค่าตั๋วชนทางแอร์", topic:"ค่าเช่าเครื่องบินขนสินค้า", need_receipt:true, need_slip:true, need_withholding:false, withholding_pct:0 },
  { category:"ใบขนรถ", item:"ค่าใบขนรถ", topic:"ค่าใบขนสินค้าทางรถ", need_receipt:true, need_slip:true, need_withholding:false, withholding_pct:0 },
];

const rolePermissions = [
  { key:"admin", label:"Admin", permissions:{ dashboard:true,expense:true,freight:true,statement:true,documents:true,settings:true,users:true,logs:true,revenue:true } },
  { key:"accounting", label:"Accounting", permissions:{ dashboard:true,expense:true,freight:true,statement:true,documents:true,settings:true,users:false,logs:true,revenue:true } },
  { key:"manager", label:"Manager", permissions:{ dashboard:true,expense:true,freight:true,statement:true,documents:true,settings:true,users:false,logs:true,revenue:true } },
  { key:"staff", label:"Staff", permissions:{ dashboard:true,expense:true,freight:true,statement:false,documents:false,settings:false,users:false,logs:false,revenue:false } },
  { key:"viewer", label:"Viewer", permissions:{ dashboard:true,expense:true,freight:true,statement:false,documents:false,settings:false,users:false,logs:false,revenue:false } }
];

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
  showLoadingOverlay(true);
  try {
    await loadAllData();
    await seedExpenseMasterIfEmpty();
    bindGlobalEvents();
    initDefaultDates();
    populateStaticDropdowns();
    renderAllTables();
    updateLoginRoleOptions();
    updateUserRoleOptions();
    startRealtimePolling();  // Phase 4
  } catch(e) {
    toast("error","โหลดข้อมูลไม่สำเร็จ", e.message || "กรุณาตรวจสอบการเชื่อมต่อ Supabase");
    console.error(e);
  } finally {
    showLoadingOverlay(false);
  }
  showLoginScreen();
});

function showLoadingOverlay(show) {
  let el = $("#loadingOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "loadingOverlay";
    el.innerHTML = `<div class="loading-spinner"></div><p>กำลังโหลดข้อมูล…</p>`;
    document.body.appendChild(el);
  }
  el.style.display = show ? "flex" : "none";
}

// ============================================================
// REALTIME POLLING — Phase 4
// polling ทุก 15 วินาที ดึงข้อมูลใหม่จาก Supabase
// ครอบคลุมข้อมูลที่พนักงานกรอกผ่าน Google Sheets → Apps Script → Supabase
// ============================================================
function startRealtimePolling(intervalMs = 15000) {
  if (appState.realtimeTimer) clearInterval(appState.realtimeTimer);
  appState.realtimeTimer = setInterval(async () => {
    if (!appState.currentUser) return;  // ไม่ polling ถ้ายังไม่ login
    try {
      await refreshData(
        "expense_requests_cargo",
        "expense_requests_freight",
        "freight_shipments",
        "revenues"
      );
      renderAllTables();
      showRealtimePulse();
    } catch(e) {
      console.warn("Realtime poll failed:", e.message);
    }
  }, intervalMs);
}

function showRealtimePulse() {
  let dot = $("#realtimeDot");
  if (!dot) {
    dot = document.createElement("span");
    dot.id = "realtimeDot";
    dot.title = "ข้อมูลอัปเดต realtime";
    dot.style.cssText = `
      position:fixed; bottom:60px; right:16px; z-index:110;
      width:10px; height:10px; border-radius:50%;
      background:var(--pcs-green); box-shadow:0 0 0 0 rgba(6,118,71,0.4);
      animation:realtimePing 0.8s ease-out;
    `;
    document.body.appendChild(dot);
    // inject keyframe once
    if (!document.getElementById("realtimeStyle")) {
      const s = document.createElement("style");
      s.id = "realtimeStyle";
      s.textContent = `@keyframes realtimePing{0%{transform:scale(1);opacity:1}100%{transform:scale(2.5);opacity:0}}`;
      document.head.appendChild(s);
    }
  }
  dot.style.animation = "none";
  void dot.offsetWidth;
  dot.style.animation = "realtimePing 0.8s ease-out";
}

async function loadAllData() {
  const results = await Promise.allSettled([
    sb.select("service_costs","order=created_at.asc"),
    sb.select("expense_master","order=created_at.asc"),
    sb.select("banks","order=created_at.asc"),
    sb.select("tax_rules","order=created_at.asc"),
    sb.select("users","order=created_at.asc"),
    sb.select("expense_requests","order=created_at.desc&mode=eq.cargo"),
    sb.select("freight_shipments","order=created_at.desc"),
    sb.select("expense_requests","order=created_at.desc&mode=eq.freight"),
    sb.select("statement_rows","order=date.desc,created_at.desc"),
    sb.select("revenues","order=created_at.desc")
  ]);

  const safe = (r, fallback=[]) => r.status === "fulfilled" ? r.value : fallback;
  appState.serviceCosts      = safe(results[0]);
  appState.expenseMaster     = safe(results[1]);
  appState.banks             = safe(results[2]);
  appState.taxRules          = safe(results[3]);
  appState.users             = safe(results[4]);
  appState.expenseRequests   = safe(results[5]);
  appState.freightShipments  = safe(results[6]);
  appState.freightItems      = safe(results[7]);
  appState.statementRows     = safe(results[8]);
  appState.revenues          = safe(results[9]);
}

// Seed expense master ถ้า DB ยังว่างอยู่
async function seedExpenseMasterIfEmpty() {
  if (appState.expenseMaster.length > 0) return;
  try {
    const rows = EXPENSE_MASTER_SEED.map(r => ({
      id: generateId("master"),
      category: r.category, item: r.item, topic: r.topic,
      service_cost_id: null,
      need_receipt: r.need_receipt, need_invoice: false,
      need_withholding: r.need_withholding, need_slip: r.need_slip,
      withholding_percent: r.withholding_pct, guide: ""
    }));
    await sb.insert("expense_master", rows);
    appState.expenseMaster = rows;
    toast("success","โหลด Master Data","ตั้งค่ารายการเบิกจากชีท Excel จริงแล้ว");
  } catch(e) {
    // ถ้า insert ไม่ได้ (เช่น table ยังไม่มี) ให้ใช้ local seed
    appState.expenseMaster = EXPENSE_MASTER_SEED.map(r => ({
      id: generateId("master"),
      category: r.category, item: r.item, topic: r.topic,
      service_cost_id: null,
      need_receipt: r.need_receipt, need_invoice: false,
      need_withholding: r.need_withholding, need_slip: r.need_slip,
      withholding_percent: r.withholding_pct, guide: ""
    }));
  }
}

async function refreshData(...tables) {
  const map = {
    service_costs:           async () => appState.serviceCosts = await sb.select("service_costs","order=created_at.asc"),
    expense_master:          async () => appState.expenseMaster = await sb.select("expense_master","order=created_at.asc"),
    banks:                   async () => appState.banks = await sb.select("banks","order=created_at.asc"),
    tax_rules:               async () => appState.taxRules = await sb.select("tax_rules","order=created_at.asc"),
    users:                   async () => appState.users = await sb.select("users","order=created_at.asc"),
    expense_requests_cargo:  async () => appState.expenseRequests = await sb.select("expense_requests","order=created_at.desc&mode=eq.cargo"),
    expense_requests_freight:async () => appState.freightItems = await sb.select("expense_requests","order=created_at.desc&mode=eq.freight"),
    freight_shipments:       async () => appState.freightShipments = await sb.select("freight_shipments","order=created_at.desc"),
    statement_rows:          async () => appState.statementRows = await sb.select("statement_rows","order=date.desc,created_at.desc"),
    revenues:                async () => appState.revenues = await sb.select("revenues","order=created_at.desc")
  };
  for (const t of tables) { if (map[t]) await map[t](); }
}

// ============================================================
// BIND EVENTS
// ============================================================
function bindGlobalEvents() {
  bindLoginEvents();
  bindLogoutEvents();
  bindMenuEvents();
  bindTopbarEvents();
  bindModalEvents();
  bindCargoFormEvents();
  bindFreightFormEvents();
  bindSettingsEvents();
  bindUserEvents();
  bindSearchAndFilters();
  bindKbizUploadEvents();
  bindRevenueEvents();   // Phase 3
}

function bindLoginEvents() {
  const loginForm = $("#loginForm");
  if (!loginForm) return;
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("#loginUsername").value.trim();
    const password = $("#loginPassword").value.trim();
    const selectedRole = $("#loginRole").value;

    let foundUser = appState.users.find(u => u.username === username && u.password === password && u.is_active);
    if (!foundUser && selectedRole) {
      foundUser = appState.users.find(u => u.role === selectedRole && u.is_active);
    }
    if (!foundUser) {
      toast("error","เข้าสู่ระบบไม่สำเร็จ","ไม่พบผู้ใช้งานหรือ role ที่เลือก");
      return;
    }

    await sb.update("users", { last_login: new Date().toISOString() }, { id: foundUser.id });
    appState.currentUser = foundUser;
    await addLog("LOGIN", "-", "เข้าสู่ระบบ");
    updateCurrentUserUI();
    applyRolePermissions();
    showApp();
    setActivePage("dashboard-page");
    renderAllTables();
    toast("success","เข้าสู่ระบบสำเร็จ",`ยินดีต้อนรับ ${foundUser.full_name}`);
  });
}

function bindLogoutEvents() {
  ["logoutBtnSide","logoutBtnTop"].forEach(id => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener("click", async () => {
      if (appState.currentUser) await addLog("LOGOUT","-","ออกจากระบบ");
      appState.currentUser = null;
      appState.selectedShipmentId = null;
      showLoginScreen();
      toast("success","ออกจากระบบแล้ว","");
    });
  });
}

function bindMenuEvents() {
  $$(".menu-item[data-page]").forEach(item => {
    item.addEventListener("click", () => {
      if (item.classList.contains("disabled")) return;
      const pageId = item.dataset.page;
      if (!hasPermission(pageIdToPermission(pageId))) {
        toast("warning","ไม่มีสิทธิ์เข้าใช้งาน","role นี้ยังไม่มีสิทธิ์เข้าหน้านี้");
        return;
      }
      setActivePage(pageId);
    });
  });
}

function bindTopbarEvents() {
  const sidebarToggle = $("#sidebarToggle");
  if (sidebarToggle) sidebarToggle.addEventListener("click", () => $("#sidebar").classList.toggle("is-open"));

  const userToggle = $("#userDropdownToggle");
  const userMenu = $("#userDropdownMenu");
  if (userToggle && userMenu) {
    userToggle.addEventListener("click", () => userMenu.classList.toggle("is-open"));
    document.addEventListener("click", e => {
      if (!userToggle.contains(e.target) && !userMenu.contains(e.target)) userMenu.classList.remove("is-open");
    });
  }

  ["openCreateRequestModal","openCreateRequestModalFromExpense"].forEach(id => {
    const btn = $(`#${id}`); if (btn) btn.addEventListener("click", () => openModal("createRequestModal"));
  });
  ["openCreateShipmentModal","openCreateShipmentModalFromFreight"].forEach(id => {
    const btn = $(`#${id}`); if (btn) btn.addEventListener("click", () => openModal("createShipmentModal"));
  });

  const addFreightItemBtn = $("#openCreateFreightItemModal");
  if (addFreightItemBtn) {
    addFreightItemBtn.addEventListener("click", () => {
      if (!appState.selectedShipmentId) { toast("warning","ยังไม่ได้เลือก Shipment","กรุณาเลือก Shipment ก่อนเพิ่มรายการย่อย"); return; }
      syncSelectedShipmentToFreightModal();
      openModal("createFreightItemModal");
    });
  }

  const openProfileAction = $("#openProfileAction");
  if (openProfileAction) {
    openProfileAction.addEventListener("click", () => {
      toast("success","ข้อมูลผู้ใช้งาน",`${appState.currentUser?.full_name || "-"} • ${getRoleLabel(appState.currentUser?.role)}`);
    });
  }
}

function bindModalEvents() {
  $$("[data-close-modal]").forEach(el => {
    el.addEventListener("click", () => closeModal(el.dataset.closeModal));
  });
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") $$(".modal.is-open").forEach(m => m.classList.remove("is-open"));
  });
}

// ============================================================
// CARGO FORM
// ============================================================
function bindCargoFormEvents() {
  const cargoForm = $("#createRequestForm");
  if (!cargoForm) return;

  const slipInput = $("#requestSlipFile");
  if (slipInput) {
    slipInput.addEventListener("change", () => {
      appState.pendingSlipFile = slipInput.files[0] || null;
      const label = $("#requestSlipLabel");
      if (label) label.textContent = appState.pendingSlipFile ? appState.pendingSlipFile.name : "ยังไม่ได้แนบสลิป";
    });
  }

  $("#requestCategory").addEventListener("change", () => {
    syncItemsByCategory("requestCategory","requestItem");
    syncMasterIntoForm("requestItem",{ topicId:"requestTopic", guideTextId:"requestGuideText", serviceCostSelectId:"requestServiceCostCategory" });
  });
  $("#requestItem").addEventListener("change", () => {
    syncMasterIntoForm("requestItem",{ topicId:"requestTopic", guideTextId:"requestGuideText", serviceCostSelectId:"requestServiceCostCategory" });
  });

  cargoForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const requester = $("#requestRequester").value.trim() || appState.currentUser?.full_name || "";
    const category = $("#requestCategory").value;
    const item = $("#requestItem").value;
    const master = getMasterByItem(item);
    const amountRequested = Number($("#requestAmountRequested").value || 0);
    const amountRefund = Number($("#requestAmountRefund")?.value || 0);
    const qoNumber = $("#requestQoNumber")?.value.trim() || "";
    const term = $("#requestTerm")?.value || "";
    const containerFlightNo = $("#requestContainerFlightNo")?.value.trim() || "";
    const withholdingNo = $("#requestWithholdingNo")?.value.trim() || "";

    if (!category || !item || !master) { toast("warning","ข้อมูลไม่ครบ","กรุณาเลือกหมวดหมู่และรายการเบิก"); return; }
    if (amountRequested <= 0 && amountRefund <= 0) { toast("warning","จำนวนเงินไม่ถูกต้อง","กรุณากรอกจำนวนเงินยอดเบิกหรือยอดคืน"); return; }
    if (!appState.pendingSlipFile) { toast("warning","ยังไม่ได้แนบสลิป","กรุณาแนบสลิปการโอนก่อน submit"); return; }

    const now = new Date().toISOString();
    const newRequest = {
      id: generateId("cargo"), req_no: generateReqNo("cargo"), mode: "cargo", shipment_id: null,
      qo_number: qoNumber,
      container_flight_no: containerFlightNo,
      transport_type: $("#requestTransportType")?.value || "",
      term,
      date: $("#requestDate").value || todayISO(), draft_created_at: now, submitted_at: now,
      requester, requester_role: appState.currentUser?.role || "staff",
      category, item, topic: master.topic,
      service_cost_id: $("#requestServiceCostCategory").value || master.service_cost_id || null,
      note: $("#requestNote").value.trim(),
      amount_requested: amountRequested,
      amount_refund: amountRefund,
      amount_approved: amountRequested, amount_used: 0, amount_covered: 0,
      bank: $("#requestBank").value, account_name: $("#requestAccountName").value.trim(),
      account_no: $("#requestAccountNo").value.trim(), transfer_date: $("#requestDate").value || todayISO(),
      transfer_status: "ต้องการเบิก",  // Phase 4: สถานะโอนเงิน
      receipt_status: "รอใบเสร็จ",      // Phase 4: สถานะตามใบเสร็จ
      withholding_no: withholdingNo,     // Phase 4: เลขที่ใบหัก ณ ที่จ่าย
      need_receipt: !!master.need_receipt, need_invoice: !!master.need_invoice,
      need_withholding: !!master.need_withholding, need_slip: !!master.need_slip,
      has_receipt: false, has_invoice: false, has_withholding: false, has_slip: false,
      slip_filename: appState.pendingSlipFile.name, slip_uploaded_at: now,
      statement_matched: false, statement_match_confidence: 0, status: "draft",
      source: "web"  // บอกว่ามาจาก Web UI (ไม่ใช่ Google Sheets)
    };

    try {
      await sb.insert("expense_requests", newRequest);
      await addLog("CREATE_CARGO", newRequest.req_no, `สร้างรายการเบิกคาร์โก้ ${newRequest.item}`);
      appState.pendingSlipFile = null;
      cargoForm.reset();
      if ($("#requestSlipLabel")) $("#requestSlipLabel").textContent = "ยังไม่ได้แนบสลิป";
      initDefaultDates();
      await refreshData("expense_requests_cargo");
      populateStaticDropdowns();
      renderAllTables();
      closeModal("createRequestModal");
      toast("success","บันทึกรายการสำเร็จ",`สร้าง ${newRequest.req_no} เรียบร้อย`);
    } catch(err) { toast("error","บันทึกไม่สำเร็จ", err.message); }
  });
}

// ============================================================
// FREIGHT FORM
// ============================================================
function bindFreightFormEvents() {
  const shipmentForm = $("#createShipmentForm");
  const freightItemForm = $("#createFreightItemForm");

  if (shipmentForm) {
    shipmentForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const shipmentNo = $("#shipmentNo").value.trim() || generateShipmentNo();
      const customerName = $("#shipmentCustomerName").value.trim();
      const transportType = $("#shipmentTransportType").value;
      if (!customerName || !transportType) { toast("warning","ข้อมูลไม่ครบ","กรุณากรอกชื่อลูกค้าและประเภทขนส่ง"); return; }

      const shipment = {
        id: generateId("shipment"), shipment_no: shipmentNo,
        date: $("#shipmentDate").value || todayISO(), customer_name: customerName,
        transport_type: transportType, term: $("#shipmentTerm")?.value || "",
        origin: $("#shipmentOrigin").value.trim(), destination: $("#shipmentDestination").value.trim(),
        owner: $("#shipmentOwner").value.trim() || appState.currentUser?.full_name || "",
        note: $("#shipmentNote").value.trim(), status: $("#shipmentStatus").value || "draft",
        created_by: appState.currentUser?.full_name || ""
      };

      try {
        await sb.insert("freight_shipments", shipment);
        appState.selectedShipmentId = shipment.id;
        await addLog("CREATE_SHIPMENT", shipment.shipment_no, "สร้าง Shipment เฟรท");
        shipmentForm.reset(); initDefaultDates();
        await refreshData("freight_shipments");
        renderAllTables();
        syncSelectedShipmentToFreightModal();
        closeModal("createShipmentModal");
        toast("success","สร้าง Shipment สำเร็จ",`${shipment.shipment_no} ถูกสร้างแล้ว`);
      } catch(err) { toast("error","บันทึกไม่สำเร็จ", err.message); }
    });
  }

  if (freightItemForm) {
    const freightSlipInput = $("#freightItemSlipFile");
    if (freightSlipInput) {
      freightSlipInput.addEventListener("change", () => {
        appState.pendingFreightSlipFile = freightSlipInput.files[0] || null;
        const label = $("#freightItemSlipLabel");
        if (label) label.textContent = appState.pendingFreightSlipFile ? appState.pendingFreightSlipFile.name : "ยังไม่ได้แนบสลิป";
      });
    }

    $("#freightItemCategory").addEventListener("change", () => {
      syncItemsByCategory("freightItemCategory","freightItemItem");
      syncMasterIntoForm("freightItemItem",{ topicId:"freightItemTopic", guideTextId:"freightItemGuideText", serviceCostSelectId:"freightItemServiceCostCategory" });
    });
    $("#freightItemItem").addEventListener("change", () => {
      syncMasterIntoForm("freightItemItem",{ topicId:"freightItemTopic", guideTextId:"freightItemGuideText", serviceCostSelectId:"freightItemServiceCostCategory" });
    });

    freightItemForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const shipmentId = $("#freightItemShipmentId").value || appState.selectedShipmentId;
      const shipment = getShipmentById(shipmentId);
      if (!shipment) { toast("warning","ไม่พบ Shipment","กรุณาเลือก Shipment ก่อนบันทึก"); return; }

      const category = $("#freightItemCategory").value;
      const item = $("#freightItemItem").value;
      const master = getMasterByItem(item);
      const amountRequested = Number($("#freightItemAmountRequested").value || 0);
      const amountRefund = Number($("#freightItemAmountRefund")?.value || 0);
      const qoNumber = $("#freightItemQoNumber")?.value.trim() || "";
      const containerFlightNo = $("#freightItemContainerFlightNo")?.value.trim() || "";
      const withholdingNo = $("#freightItemWithholdingNo")?.value.trim() || "";
      const creditDays = Number($("#freightItemCreditDays")?.value || 0);

      if (!category || !item || !master) { toast("warning","ข้อมูลไม่ครบ","กรุณาเลือกหมวดหมู่และรายการเบิก"); return; }
      if (!qoNumber) { toast("warning","ข้อมูลไม่ครบ","กรุณากรอกเลข QO ก่อน submit"); return; }
      if (amountRequested <= 0 && amountRefund <= 0) { toast("warning","จำนวนเงินไม่ถูกต้อง","กรุณากรอกจำนวนเงิน"); return; }
      if (!appState.pendingFreightSlipFile) { toast("warning","ยังไม่ได้แนบสลิป","กรุณาแนบสลิปการโอนก่อน submit"); return; }

      const now = new Date().toISOString();
      const term = $("#freightItemTerm")?.value || shipment.term || "";
      const newItem = {
        id: generateId("freight-item"), req_no: generateReqNo("freight"), mode: "freight",
        shipment_id: shipment.id,
        qo_number: qoNumber,
        container_flight_no: containerFlightNo,
        transport_type: shipment.transport_type, term,
        date: $("#freightItemDate").value || todayISO(), draft_created_at: now, submitted_at: now,
        requester: $("#freightItemRequester").value.trim() || appState.currentUser?.full_name || "",
        requester_role: appState.currentUser?.role || "staff",
        category, item, topic: master.topic,
        service_cost_id: $("#freightItemServiceCostCategory").value || master.service_cost_id || null,
        note: $("#freightItemNote").value.trim(),
        amount_requested: amountRequested,
        amount_refund: amountRefund,
        amount_approved: amountRequested, amount_used: 0, amount_covered: 0,
        bank: $("#freightItemBank").value, account_name: $("#freightItemAccountName").value.trim(),
        account_no: $("#freightItemAccountNo").value.trim(), transfer_date: $("#freightItemDate").value || todayISO(),
        transfer_status: "ต้องการเบิก",
        receipt_status: "รอใบเสร็จ",
        withholding_no: withholdingNo,
        credit_days: creditDays,
        need_receipt: !!master.need_receipt, need_invoice: !!master.need_invoice,
        need_withholding: !!master.need_withholding, need_slip: !!master.need_slip,
        has_receipt: false, has_invoice: false, has_withholding: false, has_slip: false,
        slip_filename: appState.pendingFreightSlipFile.name, slip_uploaded_at: now,
        statement_matched: false, statement_match_confidence: 0, status: "draft",
        source: "web"
      };

      try {
        await sb.insert("expense_requests", newItem);
        await addLog("CREATE_FREIGHT_ITEM", newItem.req_no, `เพิ่มรายการใต้ ${shipment.shipment_no}`);
        appState.pendingFreightSlipFile = null;
        freightItemForm.reset();
        if ($("#freightItemSlipLabel")) $("#freightItemSlipLabel").textContent = "ยังไม่ได้แนบสลิป";
        initDefaultDates();
        await refreshData("expense_requests_freight");
        renderAllTables();
        syncSelectedShipmentToFreightModal();
        closeModal("createFreightItemModal");
        toast("success","เพิ่มรายการสำเร็จ",`เพิ่ม ${newItem.req_no} ใต้ ${shipment.shipment_no}`);
      } catch(err) { toast("error","บันทึกไม่สำเร็จ", err.message); }
    });
  }
}

// ============================================================
// PHASE 3 — REVENUE EVENTS
// ============================================================
function bindRevenueEvents() {
  bindSimpleOpenButton("openCreateRevenueModal","createRevenueModal");

  // Auto-populate QO and revenue_no from shipment selection
  const revShipmentSelect = $("#revenueShipmentId");
  if (revShipmentSelect) {
    revShipmentSelect.addEventListener("change", () => {
      const shipment = getShipmentById(revShipmentSelect.value);
      if (shipment) {
        if ($("#revenueCustomerName")) $("#revenueCustomerName").value = shipment.customer_name || "";
        if ($("#revenueTerm")) $("#revenueTerm").value = shipment.term || "";
        if ($("#revenueTransportType")) $("#revenueTransportType").value = shipment.transport_type || "";
      }
    });
  }

  const revenueForm = $("#createRevenueForm");
  if (!revenueForm) return;

  revenueForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const shipmentId = $("#revenueShipmentId").value;
    const qoNumber = $("#revenueQoNumber").value.trim();
    const invoiceNumber = $("#revenueInvoiceNumber").value.trim();
    const amount = Number($("#revenueAmount").value || 0);
    const paymentType = $("#revenuePaymentType").value || "เงินสด";

    if (!shipmentId) { toast("warning","ข้อมูลไม่ครบ","กรุณาเลือก Shipment"); return; }
    if (amount <= 0) { toast("warning","จำนวนเงินไม่ถูกต้อง","กรุณากรอกยอดรับชำระมากกว่า 0"); return; }

    const shipment = getShipmentById(shipmentId);
    const now = new Date().toISOString();
    const newRevenue = {
      id: generateId("rev"),
      revenue_no: generateRevenueNo(),
      shipment_id: shipmentId,
      shipment_no: shipment?.shipment_no || "",
      qo_number: qoNumber,
      invoice_number: invoiceNumber,
      customer_name: $("#revenueCustomerName").value.trim() || shipment?.customer_name || "",
      transport_type: $("#revenueTransportType").value || shipment?.transport_type || "",
      term: $("#revenueTerm").value || shipment?.term || "",
      date: $("#revenueDate").value || todayISO(),
      amount_charged: amount,
      amount_received: Number($("#revenueAmountReceived").value || amount),
      payment_type: paymentType,
      credit_days: Number($("#revenueCreditDays").value || 0),
      has_withholding_from_customer: $("#revenueHasWithholdingFromCustomer").checked,
      withholding_amount_from_customer: Number($("#revenueWithholdingAmount").value || 0),
      status: $("#revenueAmountReceived").value && Number($("#revenueAmountReceived").value) >= amount ? "received" : "pending",
      note: $("#revenueNote").value.trim(),
      created_by: appState.currentUser?.full_name || "",
      created_at: now
    };

    try {
      await sb.insert("revenues", newRevenue);
      await addLog("CREATE_REVENUE", newRevenue.revenue_no, `บันทึกรายรับ ${shipment?.shipment_no || "-"} ฿${amount.toLocaleString()}`);
      revenueForm.reset();
      if ($("#revenueHasWithholdingFromCustomer")) $("#revenueHasWithholdingFromCustomer").checked = false;
      initDefaultDates();
      await refreshData("revenues");
      renderAllTables();
      closeModal("createRevenueModal");
      toast("success","บันทึกรายรับสำเร็จ",`${newRevenue.revenue_no} • ฿${amount.toLocaleString()}`);
    } catch(err) {
      // Graceful fallback — table may not exist yet, store locally
      appState.revenues.unshift(newRevenue);
      revenueForm.reset();
      initDefaultDates();
      renderAllTables();
      closeModal("createRevenueModal");
      toast("success","บันทึกรายรับสำเร็จ (local)",`${newRevenue.revenue_no}`);
    }
  });

  // Toggle withholding amount field visibility
  const withholdingCheck = $("#revenueHasWithholdingFromCustomer");
  const withholdingField = $("#revenueWithholdingField");
  if (withholdingCheck && withholdingField) {
    withholdingCheck.addEventListener("change", () => {
      withholdingField.classList.toggle("is-hidden", !withholdingCheck.checked);
    });
  }

  // Revenue search filter
  const revSearch = $("#revenueSearchInput");
  if (revSearch) revSearch.addEventListener("input", renderRevenueTable);

  const revStatusFilter = $("#revenueStatusFilter");
  if (revStatusFilter) revStatusFilter.addEventListener("change", renderRevenueTable);
}

// ============================================================
// SETTINGS EVENTS
// ============================================================
function bindSettingsEvents() {
  bindSimpleOpenButton("openExpenseMasterModal","expenseMasterModal");
  bindSimpleOpenButton("openServiceCostModal","serviceCostModal");
  bindSimpleOpenButton("openBankModal","bankModal");
  bindSimpleOpenButton("openTaxRuleModal","taxRuleModal");

  const serviceCostForm = $("#serviceCostForm");
  if (serviceCostForm) {
    serviceCostForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = $("#serviceCostCode").value.trim();
      const name = $("#serviceCostName").value.trim();
      if (!code || !name) { toast("warning","ข้อมูลไม่ครบ","กรุณากรอกรหัสและชื่อต้นทุนบริการ"); return; }
      try {
        await sb.insert("service_costs", { id:generateId("sc"), code, name, description:$("#serviceCostDescription").value.trim(), is_active:$("#serviceCostIsActive").checked });
        await addLog("CREATE_SERVICE_COST", code, `เพิ่มต้นทุนบริการ ${name}`);
        serviceCostForm.reset(); $("#serviceCostIsActive").checked = true;
        await refreshData("service_costs"); populateStaticDropdowns(); renderAllTables();
        closeModal("serviceCostModal"); toast("success","บันทึกสำเร็จ","เพิ่มหมวดต้นทุนบริการแล้ว");
      } catch(err) { toast("error","บันทึกไม่สำเร็จ",err.message); }
    });
  }

  const expenseMasterForm = $("#expenseMasterForm");
  if (expenseMasterForm) {
    expenseMasterForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const category = $("#masterCategory").value.trim();
      const item = $("#masterItem").value.trim();
      const topic = $("#masterTopic").value.trim();
      if (!category || !item || !topic) { toast("warning","ข้อมูลไม่ครบ","กรุณากรอกหมวดหมู่ รายการ และหัวข้อ"); return; }
      try {
        await sb.insert("expense_master", { id:generateId("master"), category, item, topic, service_cost_id:$("#masterServiceCostCategory").value||null, need_receipt:$("#masterNeedReceipt").checked, need_invoice:$("#masterNeedInvoice").checked, need_withholding:$("#masterNeedWithholding").checked, need_slip:$("#masterNeedSlip").checked, withholding_percent:Number($("#masterWithholdingPercent").value||0), guide:$("#masterGuide").value.trim() });
        await addLog("CREATE_MASTER", item, `เพิ่ม master รายการเบิก ${item}`);
        expenseMasterForm.reset();
        await refreshData("expense_master"); populateStaticDropdowns(); renderAllTables();
        closeModal("expenseMasterModal"); toast("success","บันทึกสำเร็จ","เพิ่มรายการตั้งค่าแล้ว");
      } catch(err) { toast("error","บันทึกไม่สำเร็จ",err.message); }
    });
  }

  const bankForm = $("#bankForm");
  if (bankForm) {
    bankForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const bankName = $("#bankName").value.trim();
      const accountNo = $("#bankAccountNo").value.trim();
      const accountName = $("#bankAccountName").value.trim();
      if (!bankName || !accountNo || !accountName) { toast("warning","ข้อมูลไม่ครบ","กรุณากรอกข้อมูลธนาคารให้ครบ"); return; }
      try {
        await sb.insert("banks", { id:generateId("bank"), bank_name:bankName, account_no:accountNo, account_name:accountName, account_type:$("#bankAccountType").value, use_for_statement:$("#bankUseForStatement").checked });
        await addLog("CREATE_BANK", bankName, "เพิ่มบัญชีธนาคาร");
        bankForm.reset(); $("#bankUseForStatement").checked = true;
        await refreshData("banks"); populateStaticDropdowns(); renderAllTables();
        closeModal("bankModal"); toast("success","บันทึกสำเร็จ","เพิ่มธนาคารแล้ว");
      } catch(err) { toast("error","บันทึกไม่สำเร็จ",err.message); }
    });
  }

  const taxRuleForm = $("#taxRuleForm");
  if (taxRuleForm) {
    taxRuleForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const itemRef = $("#taxRuleItemRef").value.trim();
      if (!itemRef) { toast("warning","ข้อมูลไม่ครบ","กรุณากรอกอ้างอิงรายการ"); return; }
      try {
        await sb.insert("tax_rules", { id:generateId("tax"), item_ref:itemRef, percent:Number($("#taxRulePercent").value||0), need_receipt:$("#taxRuleNeedReceipt").checked, need_slip:$("#taxRuleNeedSlip").checked, need_withholding:$("#taxRuleNeedWithholding").checked, guide:$("#taxRuleGuide").value.trim() });
        await addLog("CREATE_TAX_RULE", itemRef, "เพิ่มกฎภาษี");
        taxRuleForm.reset();
        await refreshData("tax_rules"); renderAllTables();
        closeModal("taxRuleModal"); toast("success","บันทึกสำเร็จ","เพิ่มกฎภาษีแล้ว");
      } catch(err) { toast("error","บันทึกไม่สำเร็จ",err.message); }
    });
  }
}

function bindUserEvents() {
  const userForm = $("#userForm");
  bindSimpleOpenButton("openUserModal","userModal");
  if (!userForm) return;
  userForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fullName = $("#userFullName").value.trim();
    const username = $("#userUsername").value.trim();
    const password = $("#userPassword").value.trim();
    if (!fullName || !username || !password) { toast("warning","ข้อมูลไม่ครบ","กรุณากรอกชื่อ Username และ Password"); return; }
    if (appState.users.some(u => u.username === username)) { toast("warning","Username ซ้ำ","กรุณาใช้ Username อื่น"); return; }
    try {
      await sb.insert("users", { id:generateId("user"), full_name:fullName, username, password, role:$("#userRole").value, department:$("#userDepartment").value.trim(), is_active:$("#userIsActive").checked });
      await addLog("CREATE_USER", username, "เพิ่มผู้ใช้งาน");
      userForm.reset(); $("#userIsActive").checked = true;
      await refreshData("users"); renderAllTables();
      closeModal("userModal"); toast("success","บันทึกสำเร็จ","เพิ่มผู้ใช้งานแล้ว");
    } catch(err) { toast("error","บันทึกไม่สำเร็จ",err.message); }
  });
}

function bindSearchAndFilters() {
  const globalSearch = $("#globalSearch");
  if (globalSearch) globalSearch.addEventListener("input", renderAllTables);
  ["expenseSearchInput","expenseCategoryFilter","expenseItemFilter","expenseDocStatusFilter","expenseStatementFilter",
   "expenseTransferFilter","expenseSourceFilter",
   "freightSearchInput","freightTransportFilter","freightStatusFilter","freightDocFilter"].forEach(id => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener("input", renderAllTables);
    el.addEventListener("change", renderAllTables);
  });
}

// ============================================================
// PHASE 2 — KBIZ CSV
// ============================================================
function bindKbizUploadEvents() {
  const kbizUploadBtn = $("#kbizUploadBtn");
  const kbizFileInput = $("#kbizFileInput");
  if (!kbizUploadBtn || !kbizFileInput) return;

  kbizUploadBtn.addEventListener("click", () => kbizFileInput.click());
  kbizFileInput.addEventListener("change", async () => {
    const file = kbizFileInput.files[0];
    if (!file) return;
    try {
      kbizUploadBtn.disabled = true; kbizUploadBtn.textContent = "กำลัง Parse CSV…";
      const text = await file.text();
      const rows = parseKbizCsv(text);
      if (!rows.length) { toast("warning","ไม่พบข้อมูล","ไม่พบรายการในไฟล์ CSV"); return; }

      const existingDescs = new Set(appState.statementRows.map(r => `${r.date}|${r.debit||0}|${r.credit||0}|${r.description||""}`));
      const newRows = rows.filter(r => !existingDescs.has(`${r.date}|${r.debit||0}|${r.credit||0}|${r.description||""}`));
      const dupCount = rows.length - newRows.length;
      if (!newRows.length) { toast("warning","รายการซ้ำทั้งหมด",`CSV มี ${rows.length} รายการ ซ้ำทั้งหมด`); return; }

      const allRequests = [...appState.expenseRequests, ...appState.freightItems];
      const matched = newRows.map(row => autoMatchStatement(row, allRequests));
      await sb.insert("statement_rows", matched);
      await addLog("UPLOAD_KBIZ_CSV", file.name, `อัปโหลด ${newRows.length} รายการ (ซ้ำ ${dupCount})`);
      await refreshData("statement_rows");
      renderAllTables();
      toast("success","อัปโหลด CSV สำเร็จ",`เพิ่ม ${newRows.length} รายการ${dupCount ? ` (ข้าม ${dupCount} ซ้ำ)` : ""}`);
    } catch(err) {
      toast("error","อัปโหลดไม่สำเร็จ", err.message); console.error(err);
    } finally {
      kbizUploadBtn.disabled = false; kbizUploadBtn.textContent = "อัปโหลด KBIZ CSV"; kbizFileInput.value = "";
    }
  });
}

function parseKbizCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split("\n").map(l => l.trim()).filter(l => l);
  const batchId = `KBIZ-${Date.now()}`;
  const results = [];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    if (lines[i].includes("วันที่") && lines[i].includes("รายการ")) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error("ไม่พบ header row ใน CSV");

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 5) continue;
    const rawDate = (cols[1] || "").trim();
    const timeStr = (cols[2] || "").trim();
    const txType = (cols[3] || "").trim();
    const debitRaw = (cols[4] || "").trim();
    const creditRaw = (cols[6] || "").trim();
    const balanceRaw = (cols[8] || "").trim();
    const channel = (cols[10] || "").trim();
    const description = (cols[12] || "").trim();
    if (!rawDate || !txType || txType === "ยอดยกมา") continue;
    const dateISO = parseThaiBankDate(rawDate);
    if (!dateISO) continue;
    const debit = parseAmount(debitRaw);
    const credit = parseAmount(creditRaw);
    const balance = parseAmount(balanceRaw);
    let direction = "fee";
    if (credit > 0 && debit === 0) direction = "in";
    else if (debit > 0 && credit === 0) direction = "out";
    results.push({
      id: generateId("stmt"), upload_batch: batchId,
      date: dateISO, time_str: timeStr, transaction_type: txType,
      debit: debit || null, credit: credit || null, balance: balance || null,
      channel, description, direction,
      matched_req_no: "", matched_mode: "", match_confidence: 0, is_duplicate: false
    });
  }
  return results;
}

function parseCsvLine(line) {
  const result = []; let inQuote = false; let current = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === "," && !inQuote) { result.push(current); current = ""; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

function parseThaiBankDate(raw) {
  const m1 = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m1) { const y = m1[3].length === 2 ? `20${m1[3]}` : m1[3]; return `${y}-${m1[2].padStart(2,"0")}-${m1[1].padStart(2,"0")}`; }
  const m2 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m2) { const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3]; return `${y}-${m2[2].padStart(2,"0")}-${m2[1].padStart(2,"0")}`; }
  return null;
}

function parseAmount(raw) {
  if (!raw) return 0;
  const cleaned = raw.replace(/,/g,"").replace(/[^0-9.]/g,"");
  return cleaned ? parseFloat(cleaned) : 0;
}

function autoMatchStatement(stmtRow, allRequests) {
  let bestScore = 0, bestReq = null;
  for (const req of allRequests) {
    let score = 0;
    const amount = stmtRow.direction === "out" ? stmtRow.debit : stmtRow.credit;
    const reqAmount = Number(req.amount_requested || 0);
    if (amount && reqAmount && Math.abs(amount - reqAmount) / reqAmount < 0.01) score += 50;
    const desc = (stmtRow.description || "").toLowerCase();
    if (req.shipment_id) { const s = getShipmentById(req.shipment_id); if (s && desc.includes(s.shipment_no.toLowerCase())) score += 30; }
    if (req.qo_number && desc.includes((req.qo_number || "").toLowerCase())) score += 25;
    if (desc.includes((req.req_no || "").toLowerCase())) score += 30;
    const requesterLower = (req.requester || "").toLowerCase().split(" ")[0];
    if (requesterLower.length > 2 && desc.includes(requesterLower)) score += 10;
    const daysDiff = Math.abs((new Date(stmtRow.date) - new Date(req.date)) / 86400000);
    if (daysDiff <= 1) score += 20; else if (daysDiff <= 3) score += 10;
    if (score > bestScore) { bestScore = score; bestReq = req; }
  }
  if (bestScore >= 80 && bestReq) return { ...stmtRow, matched_req_no: bestReq.req_no, matched_mode: bestReq.mode, match_confidence: Math.min(bestScore, 99) };
  if (bestScore >= 50 && bestReq) return { ...stmtRow, matched_req_no: bestReq.req_no, matched_mode: bestReq.mode, match_confidence: bestScore };
  return stmtRow;
}

// ============================================================
// RENDER ALL
// ============================================================
function renderAllTables() {
  renderDashboard();
  renderExpenseTable();
  renderFreightShipmentTable();
  renderFreightItemTable();
  renderStatementTable();
  renderDocumentsTable();
  renderRoleTable();
  renderExpenseMasterTable();
  renderServiceCostTable();
  renderBankTable();
  renderTaxRuleTable();
  renderUserTable();
  renderRevenueTable();         // Phase 3
  populateStaticDropdowns();
  updateSelectedShipmentSummary();
}

// ============================================================
// DASHBOARD (Phase 3 enhanced)
// ============================================================
function renderDashboard() {
  const allRequests = [...appState.expenseRequests, ...appState.freightItems];
  const totalRequested = allRequests.reduce((s,r) => s+Number(r.amount_requested||0), 0);
  const totalApproved  = allRequests.reduce((s,r) => s+Number(r.amount_approved||0), 0);
  const pendingDocs    = allRequests.filter(r => !isDocumentComplete(r)).length;
  const reconciled     = allRequests.filter(r => r.statement_matched).length;

  // Phase 3 calculations
  const totalRevenue   = appState.revenues.reduce((s,r) => s+Number(r.amount_charged||0), 0);
  const totalReceived  = appState.revenues.reduce((s,r) => s+Number(r.amount_received||0), 0);
  const pendingRevenue = totalRevenue - totalReceived;
  const grossProfit    = totalRevenue - totalApproved;

  setText("sumRequestAmount", formatCurrency(totalRequested));
  setText("sumApprovedAmount", formatCurrency(totalApproved));
  setText("sumPendingDocs", String(pendingDocs));
  setText("sumReconciled", String(reconciled));

  // Phase 3 stat cards (update if elements exist)
  setText("sumTotalRevenue", formatCurrency(totalRevenue));
  setText("sumGrossProfit", formatCurrency(grossProfit));
  setText("sumPendingRevenue", formatCurrency(pendingRevenue));

  setText("dashboardCargoCount", String(appState.expenseRequests.length));
  setText("dashboardFreightShipmentCount", String(appState.freightShipments.length));
  setText("dashboardFreightItemCount", String(appState.freightItems.length));
  setText("dashboardServiceCostCount", String(appState.serviceCosts.filter(s=>s.is_active).length));

  // Profit per shipment mini table
  renderDashboardProfitTable();

  const followupBody = $("#dashboardFollowupTableBody");
  if (!followupBody) return;
  const followups = [];
  appState.expenseRequests.filter(r => !isDocumentComplete(r) || !r.statement_matched).forEach(r => {
    followups.push({ type:"คาร์โก้", no:r.req_no, owner:r.requester, detail:`${r.item} • ${r.note||"-"}`, status:r.status });
  });
  appState.freightShipments.forEach(s => {
    const items = getFreightItemsByShipmentId(s.id);
    if (items.some(it => !isDocumentComplete(it) || !it.statement_matched)) {
      followups.push({ type:"Shipment", no:s.shipment_no, owner:s.owner||s.customer_name, detail:`${s.customer_name}`, status:s.status });
    }
  });
  // Phase 3: overdue receivables
  appState.revenues.filter(r => r.status === "pending").forEach(r => {
    followups.push({ type:"ลูกหนี้ค้าง", no:r.revenue_no||r.shipment_no, owner:r.customer_name, detail:`ยังไม่รับชำระ ฿${Number(r.amount_charged||0).toLocaleString()}`, status:"pending" });
  });

  if (!followups.length) { followupBody.innerHTML = `<tr><td colspan="5"><div class="empty-state">ยังไม่มีรายการที่ต้องติดตาม</div></td></tr>`; return; }
  followupBody.innerHTML = followups.slice(0,15).map(r => `<tr><td>${r.type}</td><td>${r.no}</td><td>${r.owner}</td><td>${escapeHtml(r.detail)}</td><td>${statusBadge(r.status)}</td></tr>`).join("");
}

function renderDashboardProfitTable() {
  const tbody = $("#dashboardProfitTableBody");
  if (!tbody) return;

  // Build per-shipment profit summary
  const rows = [];
  appState.freightShipments.forEach(s => {
    const items = getFreightItemsByShipmentId(s.id);
    const totalCost = items.reduce((sum,r) => sum+Number(r.amount_approved||0), 0);
    const revsForShipment = appState.revenues.filter(r => r.shipment_id === s.id);
    const totalRev = revsForShipment.reduce((sum,r) => sum+Number(r.amount_charged||0), 0);
    const profit = totalRev - totalCost;
    if (totalRev > 0 || totalCost > 0) {
      rows.push({ shipment_no: s.shipment_no, customer: s.customer_name, transport: s.transport_type, cost: totalCost, revenue: totalRev, profit, status: s.status });
    }
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">ยังไม่มีข้อมูลกำไร/ขาดทุน — กรอกรายรับก่อน</div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.slice(0, 10).map(r => `
    <tr>
      <td>${escapeHtml(r.shipment_no)}</td>
      <td>${escapeHtml(r.customer)}</td>
      <td>${transportBadge(r.transport)}</td>
      <td class="text-right">${formatCurrency(r.revenue)}</td>
      <td class="text-right">${formatCurrency(r.cost)}</td>
      <td class="text-right"><strong class="${r.profit >= 0 ? 'text-green' : 'text-red'}">${formatCurrency(r.profit)}</strong></td>
      <td>${statusBadge(r.status)}</td>
    </tr>
  `).join("");
}

// ============================================================
// PHASE 3 — REVENUE TABLE
// ============================================================
function renderRevenueTable() {
  const tbody = $("#revenueTableBody");
  if (!tbody) return;

  const search = ($("#revenueSearchInput")?.value||"").toLowerCase();
  const statusFilter = $("#revenueStatusFilter")?.value||"";

  let rows = appState.revenues.filter(r => {
    const h = [r.revenue_no,r.shipment_no,r.qo_number,r.customer_name,r.invoice_number,r.note].join(" ").toLowerCase();
    const matchSearch = !search || h.includes(search);
    const matchStatus = !statusFilter || r.status === statusFilter;
    return matchSearch && matchStatus;
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state">ยังไม่มีข้อมูลรายรับ — กด "+ บันทึกรายรับ" เพื่อเพิ่ม</div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(row => {
    const outstanding = Number(row.amount_charged||0) - Number(row.amount_received||0);
    const withholdingBadge = row.has_withholding_from_customer
      ? badge(`ได้รับแล้ว ฿${Number(row.withholding_amount_from_customer||0).toLocaleString()}`,"green")
      : badge("ยังไม่ได้รับ","red");
    return `
    <tr>
      <td>${row.revenue_no||"-"}</td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.shipment_no||"-")}</td>
      <td>${escapeHtml(row.customer_name||"-")}</td>
      <td>${escapeHtml(row.qo_number||"-")}</td>
      <td>${transportBadge(row.transport_type)}</td>
      <td class="text-right">${formatCurrency(row.amount_charged)}</td>
      <td class="text-right">${formatCurrency(row.amount_received)}</td>
      <td class="text-right ${outstanding > 0 ? "text-red" : "text-green"}">${formatCurrency(outstanding)}</td>
      <td>${withholdingBadge}</td>
      <td>${revenuStatusBadge(row.status)}</td>
      <td>
        <div class="table-actions">
          <button class="action-btn primary" onclick="openRevenueDetail('${row.id}')">ดู</button>
          <button class="action-btn success" onclick="markRevenueReceived('${row.id}')">รับชำระแล้ว</button>
          <button class="action-btn warn" onclick="toggleRevenueWithholding('${row.id}')">สลับใบหัก</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  // Summary bar
  const summaryBar = $("#revenueSummaryBar");
  if (summaryBar) {
    const totalCharged  = rows.reduce((s,r) => s+Number(r.amount_charged||0), 0);
    const totalReceived = rows.reduce((s,r) => s+Number(r.amount_received||0), 0);
    const totalOutstanding = totalCharged - totalReceived;
    summaryBar.innerHTML = `
      <div class="stmt-summary-item"><span>ยอดขายทั้งหมด</span><strong class="text-green">${formatCurrency(totalCharged)}</strong></div>
      <div class="stmt-summary-item"><span>รับชำระแล้ว</span><strong>${formatCurrency(totalReceived)}</strong></div>
      <div class="stmt-summary-item"><span>ค้างรับ</span><strong class="text-red">${formatCurrency(totalOutstanding)}</strong></div>
      <div class="stmt-summary-item"><span>จำนวนรายการ</span><strong>${rows.length}</strong></div>
    `;
  }
}

// ============================================================
// REVENUE ACTIONS
// ============================================================
async function markRevenueReceived(id) {
  const rev = appState.revenues.find(r => r.id === id);
  if (!rev) return;
  rev.amount_received = rev.amount_charged;
  rev.status = "received";
  try {
    await sb.update("revenues", { amount_received: rev.amount_received, status: "received" }, { id });
    await addLog("REVENUE_RECEIVED", rev.revenue_no||id, "รับชำระแล้ว");
    renderAllTables();
    toast("success","อัปเดตสำเร็จ",`${rev.revenue_no||rev.shipment_no} รับชำระครบแล้ว`);
  } catch(e) { renderAllTables(); toast("success","อัปเดต (local)",`${rev.revenue_no||rev.shipment_no}`); }
}

async function toggleRevenueWithholding(id) {
  const rev = appState.revenues.find(r => r.id === id);
  if (!rev) return;
  rev.has_withholding_from_customer = !rev.has_withholding_from_customer;
  try {
    await sb.update("revenues", { has_withholding_from_customer: rev.has_withholding_from_customer }, { id });
    await addLog("REVENUE_WITHHOLDING", rev.revenue_no||id, `สลับใบหัก ณ ที่จ่าย → ${rev.has_withholding_from_customer?"ได้รับ":"ยังไม่ได้รับ"}`);
    renderAllTables();
    toast("success","อัปเดตใบหัก ณ ที่จ่าย",`${rev.has_withholding_from_customer ? "✅ ได้รับใบหัก ณ ที่จ่ายแล้ว" : "❌ ยังไม่ได้รับ"}`);
  } catch(e) { renderAllTables(); }
}

function openRevenueDetail(id) {
  const rev = appState.revenues.find(r => r.id === id);
  if (!rev) return;
  const shipment = getShipmentById(rev.shipment_id);
  const items = shipment ? getFreightItemsByShipmentId(shipment.id) : [];
  const totalCost = items.reduce((s,r) => s+Number(r.amount_approved||0), 0);
  const profit = Number(rev.amount_charged||0) - totalCost;
  const outstanding = Number(rev.amount_charged||0) - Number(rev.amount_received||0);

  const html = `
    <div class="detail-section">
      <h4>ข้อมูลรายรับ</h4>
      <div class="detail-grid">
        <div class="detail-item"><span>เลขที่รายรับ</span><strong>${rev.revenue_no||"-"}</strong></div>
        <div class="detail-item"><span>วันที่</span><strong>${formatDate(rev.date)}</strong></div>
        <div class="detail-item"><span>Shipment</span><strong>${escapeHtml(rev.shipment_no||"-")}</strong></div>
        <div class="detail-item"><span>ลูกค้า</span><strong>${escapeHtml(rev.customer_name||"-")}</strong></div>
        <div class="detail-item"><span>เลข QO</span><strong>${escapeHtml(rev.qo_number||"-")}</strong></div>
        <div class="detail-item"><span>Invoice</span><strong>${escapeHtml(rev.invoice_number||"-")}</strong></div>
        <div class="detail-item"><span>Term</span><strong>${escapeHtml(rev.term||"-")}</strong></div>
        <div class="detail-item"><span>ประเภทขนส่ง</span><strong>${transportText(rev.transport_type)}</strong></div>
        <div class="detail-item"><span>ประเภทชำระ</span><strong>${escapeHtml(rev.payment_type||"-")}</strong></div>
        <div class="detail-item"><span>เครดิต (วัน)</span><strong>${rev.credit_days||0}</strong></div>
        <div class="detail-item"><span>หมายเหตุ</span><strong>${escapeHtml(rev.note||"-")}</strong></div>
        <div class="detail-item"><span>บันทึกโดย</span><strong>${escapeHtml(rev.created_by||"-")}</strong></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>สรุปการเงิน</h4>
      <div class="detail-grid">
        <div class="detail-item"><span>ยอดขาย (ราคาขาย)</span><strong>${formatCurrency(rev.amount_charged)}</strong></div>
        <div class="detail-item"><span>รับชำระแล้ว</span><strong>${formatCurrency(rev.amount_received)}</strong></div>
        <div class="detail-item"><span>ค้างรับ</span><strong class="${outstanding > 0 ? "text-red" : "text-green"}">${formatCurrency(outstanding)}</strong></div>
        <div class="detail-item"><span>ต้นทุนรวม (Shipment)</span><strong class="text-red">${formatCurrency(totalCost)}</strong></div>
        <div class="detail-item"><span>กำไรขั้นต้น</span><strong class="${profit >= 0 ? "text-green" : "text-red"}">${formatCurrency(profit)}</strong></div>
        <div class="detail-item"><span>สถานะรับชำระ</span><strong>${revenuStatusBadge(rev.status)}</strong></div>
        <div class="detail-item"><span>ใบหัก ณ ที่จ่ายจากลูกค้า</span><strong>${rev.has_withholding_from_customer ? "✅ ได้รับแล้ว" : "❌ ยังไม่ได้รับ"}</strong></div>
        <div class="detail-item"><span>จำนวนหัก ณ ที่จ่าย</span><strong>${formatCurrency(rev.withholding_amount_from_customer||0)}</strong></div>
      </div>
    </div>
    ${shipment ? `
    <div class="detail-section">
      <h4>รายการต้นทุนใต้ Shipment</h4>
      <div class="document-list">
        ${items.length ? items.map(it => `
          <div class="document-row">
            <div class="document-row__meta">
              <strong>${it.req_no} • ${escapeHtml(it.item)}</strong>
              <span>${formatCurrency(it.amount_approved)} • ${docStatusText(it)}</span>
            </div>
          </div>
        `).join("") : "<div class='empty-state'>ไม่มีรายการต้นทุน</div>"}
      </div>
    </div>` : ""}
  `;
  $("#requestDetailContent").innerHTML = html;
  openModal("requestDetailModal");
}

// ============================================================
// RENDER TABLES — Phase 4 updated
// ============================================================
function renderExpenseTable() {
  const tbody = $("#expenseTableBody");
  if (!tbody) return;
  let rows = applyCargoFilters([...appState.expenseRequests]);
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="15"><div class="empty-state">ไม่พบรายการเบิกคาร์โก้</div></td></tr>`; return; }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>
        ${row.req_no}
        ${row.source === "sheets" ? `<br><span style="font-size:11px;color:var(--pcs-green)">📊 Sheets</span>` : ""}
      </td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.requester)}</td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.item)}</td>
      <td>${row.container_flight_no ? badge(escapeHtml(row.container_flight_no),"blue") : badge("-","gray")}</td>
      <td>${row.qo_number ? badge(escapeHtml(row.qo_number),"blue") : badge("ไม่มี QO","red")}</td>
      <td class="text-right">
        ${formatCurrency(row.amount_requested)}
        ${Number(row.amount_refund||0)>0 ? `<br><small class="text-green">คืน ${formatCurrency(row.amount_refund)}</small>` : ""}
      </td>
      <td>${transferStatusBadge(row.transfer_status)}</td>
      <td>${receiptStatusBadge(row.receipt_status)}</td>
      <td>${row.withholding_no ? badge(escapeHtml(row.withholding_no),"yellow") : badge("ยังไม่มี","gray")}</td>
      <td>${docStatusBadge(row)}</td>
      <td>${row.statement_matched ? confidenceBadge(row.statement_match_confidence) : badge("Unmatched","red")}</td>
      <td>${statusBadge(row.status)}</td>
      <td>
        <div class="table-actions">
          <button class="action-btn primary" onclick="openRequestDetail('cargo','${row.id}')">ดู</button>
          <button class="action-btn success" onclick="cycleTransferStatus('cargo','${row.id}')">สถานะโอน</button>
          <button class="action-btn warn" onclick="toggleDemoDocStatus('cargo','${row.id}')">เอกสาร</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderFreightShipmentTable() {
  const tbody = $("#freightShipmentTableBody");
  if (!tbody) return;
  let rows = applyFreightShipmentFilters([...appState.freightShipments]);
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state">ไม่พบ Shipment เฟรท</div></td></tr>`; return; }
  tbody.innerHTML = rows.map(shipment => {
    const items = getFreightItemsByShipmentId(shipment.id);
    const totalAmount = items.reduce((s,r) => s+Number(r.amount_requested||0), 0);
    const allDocs = items.length ? items.every(it=>isDocumentComplete(it)) : false;
    // Phase 3: revenue linkage
    const revsForShipment = appState.revenues.filter(r => r.shipment_id === shipment.id);
    const totalRev = revsForShipment.reduce((s,r) => s+Number(r.amount_charged||0), 0);
    const profit = totalRev - totalAmount;
    return `
      <tr class="${appState.selectedShipmentId === shipment.id ? "is-selected" : ""}">
        <td>${shipment.shipment_no}</td>
        <td>${formatDate(shipment.date)}</td>
        <td>${escapeHtml(shipment.customer_name)}</td>
        <td>${transportBadge(shipment.transport_type)}</td>
        <td>${shipment.term ? badge(shipment.term,"blue") : badge("-","gray")}</td>
        <td>${escapeHtml(`${shipment.origin||"-"} - ${shipment.destination||"-"}`)}</td>
        <td>${items.length}</td>
        <td class="text-right">${formatCurrency(totalAmount)}</td>
        <td>${totalRev > 0 ? `<span class="${profit >= 0 ? "text-green" : "text-red"}">${formatCurrency(profit)}</span>` : badge("ยังไม่มีรายรับ","gray")}</td>
        <td>${allDocs ? badge("ครบ","green") : badge(items.length?"ไม่ครบ":"ยังไม่มีรายการ",items.length?"yellow":"gray")}</td>
        <td>${statusBadge(shipment.status)}</td>
        <td>
          <div class="table-actions">
            <button class="action-btn primary" onclick="selectShipment('${shipment.id}')">เลือก</button>
            <button class="action-btn success" onclick="openShipmentDetail('${shipment.id}')">ดู</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function renderFreightItemTable() {
  const tbody = $("#freightItemTableBody");
  if (!tbody) return;
  const shipmentId = appState.selectedShipmentId;
  if (!shipmentId) { tbody.innerHTML = `<tr><td colspan="14"><div class="empty-state">กรุณาเลือก Shipment จากตารางด้านบนก่อน</div></td></tr>`; return; }
  const rows = getFreightItemsByShipmentId(shipmentId);
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="14"><div class="empty-state">Shipment นี้ยังไม่มีรายการเบิกย่อย</div></td></tr>`; return; }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>
        ${row.req_no}
        ${row.source === "sheets" ? `<br><span style="font-size:11px;color:var(--pcs-green)">📊 Sheets</span>` : ""}
      </td>
      <td>${formatDate(row.date)}</td>
      <td>${escapeHtml(row.category)}</td>
      <td>${escapeHtml(row.item)}</td>
      <td>${row.container_flight_no ? badge(escapeHtml(row.container_flight_no),"blue") : badge("-","gray")}</td>
      <td>${row.qo_number ? badge(escapeHtml(row.qo_number),"blue") : badge("ไม่มี QO","red")}</td>
      <td class="text-right">
        ${formatCurrency(row.amount_requested)}
        ${Number(row.amount_refund||0)>0 ? `<br><small class="text-green">คืน ${formatCurrency(row.amount_refund)}</small>` : ""}
      </td>
      <td>${transferStatusBadge(row.transfer_status)}</td>
      <td>${receiptStatusBadge(row.receipt_status)}</td>
      <td>${row.withholding_no ? badge(escapeHtml(row.withholding_no),"yellow") : badge("-","gray")}</td>
      <td>${docStatusBadge(row)}</td>
      <td>${row.statement_matched ? confidenceBadge(row.statement_match_confidence) : badge("Unmatched","red")}</td>
      <td>${statusBadge(row.status)}</td>
      <td>
        <div class="table-actions">
          <button class="action-btn primary" onclick="openRequestDetail('freight','${row.id}')">ดู</button>
          <button class="action-btn success" onclick="cycleTransferStatus('freight','${row.id}')">สถานะโอน</button>
          <button class="action-btn warn" onclick="toggleDemoDocStatus('freight','${row.id}')">เอกสาร</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderStatementTable() {
  const tbody = $("#statementTableBody");
  if (!tbody) return;
  const inRows = appState.statementRows.filter(r => r.direction === "in");
  const outRows = appState.statementRows.filter(r => r.direction === "out");
  const totalIn  = inRows.reduce((s,r) => s+Number(r.credit||0), 0);
  const totalOut = outRows.reduce((s,r) => s+Number(r.debit||0), 0);
  const matchedRows = appState.statementRows.filter(r => r.match_confidence >= 80);
  const summaryBar = $("#statementSummaryBar");
  if (summaryBar) {
    summaryBar.innerHTML = `
      <div class="stmt-summary-item"><span>เงินเข้าทั้งหมด</span><strong class="text-green">${formatCurrency(totalIn)}</strong></div>
      <div class="stmt-summary-item"><span>เงินออกทั้งหมด</span><strong class="text-red">${formatCurrency(totalOut)}</strong></div>
      <div class="stmt-summary-item"><span>Match แล้ว</span><strong>${matchedRows.length} / ${appState.statementRows.length} รายการ</strong></div>
    `;
  }
  if (!appState.statementRows.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">ยังไม่มีข้อมูล Statement</div></td></tr>`; return;
  }
  tbody.innerHTML = appState.statementRows.map(row => `
    <tr>
      <td>${formatDate(row.date)} ${row.time_str ? `<small>${row.time_str}</small>` : ""}</td>
      <td>${escapeHtml(row.transaction_type||"-")}</td>
      <td>${escapeHtml(row.description||"-")}</td>
      <td class="text-right">${row.debit ? `<span class="text-red">${formatCurrency(row.debit)}</span>` : "-"}</td>
      <td class="text-right">${row.credit ? `<span class="text-green">${formatCurrency(row.credit)}</span>` : "-"}</td>
      <td>${directionBadge(row.direction)}</td>
      <td>${row.matched_req_no ? badge(escapeHtml(row.matched_req_no),"blue") : badge("ยังไม่จับคู่","gray")}</td>
      <td>${row.match_confidence ? confidenceBadge(row.match_confidence) : badge("0%","red")}</td>
    </tr>
  `).join("");
}

function renderDocumentsTable() {
  const tbody = $("#documentsTableBody");
  if (!tbody) return;
  const rows = [
    ...appState.expenseRequests.map(r => ({ ...r, modeLabel:"คาร์โก้", ref:r.req_no, ownerRef:r.requester })),
    ...appState.freightItems.map(r => {
      const s = getShipmentById(r.shipment_id);
      return { ...r, modeLabel:"เฟรท", ref:`${s?.shipment_no||"-"} / ${r.req_no}`, ownerRef:s?.customer_name||r.requester };
    })
  ];
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">ยังไม่มีข้อมูลเอกสาร</div></td></tr>`; return; }
  tbody.innerHTML = rows.map(row => {
    const required = getRequiredDocLabels(row).join(", ")||"-";
    const attached = getAttachedDocLabels(row).join(", ")||"-";
    return `<tr><td>${row.modeLabel}</td><td>${row.ref}</td><td>${escapeHtml(row.ownerRef)}</td><td>${escapeHtml(required)}</td><td>${escapeHtml(attached)}</td><td>${docStatusBadge(row)}</td><td><div class="table-actions"><button class="action-btn primary" onclick="openRequestDetail('${row.mode==="freight"?"freight":"cargo"}','${row.id}')">พิมพ์/ดู</button></div></td></tr>`;
  }).join("");
}

function renderRoleTable() {
  const tbody = $("#roleTableBody");
  if (!tbody) return;
  tbody.innerHTML = rolePermissions.map(role => {
    const p = role.permissions;
    return `<tr><td>${role.label}</td><td>${boolBadge(p.dashboard)}</td><td>${boolBadge(p.expense)}</td><td>${boolBadge(p.freight)}</td><td>${boolBadge(p.statement)}</td><td>${boolBadge(p.documents)}</td><td>${boolBadge(p.settings)}</td><td>${boolBadge(p.users)}</td><td>${boolBadge(p.logs)}</td><td>${boolBadge(p.revenue)}</td><td><div class="table-actions"><button class="action-btn primary">ดู</button></div></td></tr>`;
  }).join("");
}

function renderExpenseMasterTable() {
  const tbody = $("#expenseMasterTableBody");
  if (!tbody) return;
  if (!appState.expenseMaster.length) { tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state">ยังไม่มีข้อมูล master</div></td></tr>`; return; }
  tbody.innerHTML = appState.expenseMaster.map(row => `<tr><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.topic)}</td><td>${escapeHtml(getServiceCostName(row.service_cost_id))}</td><td>${boolBadge(row.need_receipt)}</td><td>${boolBadge(row.need_invoice)}</td><td>${row.need_withholding ? badge(`${row.withholding_percent||0}%`,"yellow") : boolBadge(false)}</td><td>${boolBadge(row.need_slip)}</td><td>${escapeHtml(row.guide||"-")}</td><td><div class="table-actions"><button class="action-btn primary">ดู</button></div></td></tr>`).join("");
}

function renderServiceCostTable() {
  const tbody = $("#serviceCostTableBody");
  if (!tbody) return;
  if (!appState.serviceCosts.length) { tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">ยังไม่มีข้อมูลต้นทุนบริการ</div></td></tr>`; return; }
  tbody.innerHTML = appState.serviceCosts.map(row => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.description||"-")}</td><td>${boolBadge(row.is_active)}</td><td><div class="table-actions"><button class="action-btn primary">ดู</button></div></td></tr>`).join("");
}

function renderBankTable() {
  const tbody = $("#bankTableBody");
  if (!tbody) return;
  if (!appState.banks.length) { tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">ยังไม่มีข้อมูลธนาคาร</div></td></tr>`; return; }
  tbody.innerHTML = appState.banks.map(row => `<tr><td>${escapeHtml(row.bank_name)}</td><td>${escapeHtml(row.account_no)}</td><td>${escapeHtml(row.account_name)}</td><td>${escapeHtml(row.account_type==="saving"?"ออมทรัพย์":"กระแสรายวัน")}</td><td>${boolBadge(row.use_for_statement)}</td><td><div class="table-actions"><button class="action-btn primary">ดู</button></div></td></tr>`).join("");
}

function renderTaxRuleTable() {
  const tbody = $("#taxRuleTableBody");
  if (!tbody) return;
  if (!appState.taxRules.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">ยังไม่มีกฎภาษี</div></td></tr>`; return; }
  tbody.innerHTML = appState.taxRules.map(row => `<tr><td>${escapeHtml(row.item_ref)}</td><td>${badge(`${row.percent||0}%`,"yellow")}</td><td>${boolBadge(row.need_receipt)}</td><td>${boolBadge(row.need_slip)}</td><td>${boolBadge(row.need_withholding)}</td><td>${escapeHtml(row.guide||"-")}</td><td><div class="table-actions"><button class="action-btn primary">ดู</button></div></td></tr>`).join("");
}

function renderUserTable() {
  const tbody = $("#userTableBody");
  if (!tbody) return;
  if (!appState.users.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">ยังไม่มีผู้ใช้งาน</div></td></tr>`; return; }
  tbody.innerHTML = appState.users.map(row => `<tr><td>${escapeHtml(row.full_name)}</td><td>${escapeHtml(row.username)}</td><td>${getRoleLabel(row.role)}</td><td>${escapeHtml(row.department||"-")}</td><td>${boolBadge(row.is_active)}</td><td>${escapeHtml(row.last_login||"-")}</td><td><div class="table-actions"><button class="action-btn primary">ดู</button></div></td></tr>`).join("");
}

async function renderLogTable() {
  const tbody = $("#logTableBody");
  if (!tbody) return;
  try {
    const logs = await sb.select("logs","order=created_at.desc&limit=100");
    if (!logs.length) { tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">ยังไม่มีประวัติ</div></td></tr>`; return; }
    tbody.innerHTML = logs.map(row => `<tr><td>${escapeHtml(row.created_at?.replace("T"," ").slice(0,16)||"-")}</td><td>${escapeHtml(row.user_name||"-")}</td><td>${escapeHtml(getRoleLabel(row.user_role))}</td><td>${escapeHtml(row.action||"-")}</td><td>${escapeHtml(row.ref_no||"-")}</td><td>${escapeHtml(row.detail||"-")}</td></tr>`).join("");
  } catch(e) { console.error(e); }
}

// ============================================================
// DROPDOWNS
// ============================================================
function populateStaticDropdowns() {
  populateCategoryOptions("requestCategory");
  populateCategoryOptions("freightItemCategory");
  populateCategoryFilter();
  populateItemFilter();
  populateBankOptions(["requestBank","freightItemBank"]);
  populateServiceCostOptions(["requestServiceCostCategory","freightItemServiceCostCategory","masterServiceCostCategory"]);
  populateShipmentOptions("revenueShipmentId");
  updateUserRoleOptions();
}

function populateShipmentOptions(selectId) {
  const select = $(`#${selectId}`);
  if (!select) return;
  const cur = select.value;
  select.innerHTML = `<option value="">เลือก Shipment</option>` + appState.freightShipments.map(s => `<option value="${escapeAttr(s.id)}">${escapeHtml(`${s.shipment_no} • ${s.customer_name}`)}</option>`).join("");
  if (appState.freightShipments.some(s => s.id === cur)) select.value = cur;
}

function populateCategoryOptions(selectId) {
  const select = $(`#${selectId}`);
  if (!select) return;
  const cur = select.value;
  const cats = [...new Set(appState.expenseMaster.map(r=>r.category).filter(Boolean))];
  select.innerHTML = `<option value="">เลือกหมวดหมู่</option>` + cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  if (cats.includes(cur)) select.value = cur;
}

function populateCategoryFilter() {
  const select = $("#expenseCategoryFilter");
  if (!select) return;
  const cur = select.value;
  const cats = [...new Set(appState.expenseMaster.map(r=>r.category).filter(Boolean))];
  select.innerHTML = `<option value="">ทั้งหมด</option>` + cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  if (cats.includes(cur)) select.value = cur;
}

function populateItemFilter() {
  const select = $("#expenseItemFilter");
  if (!select) return;
  const cur = select.value;
  const items = [...new Set(appState.expenseMaster.map(r=>r.item).filter(Boolean))];
  select.innerHTML = `<option value="">ทั้งหมด</option>` + items.map(i => `<option value="${escapeAttr(i)}">${escapeHtml(i)}</option>`).join("");
  if (items.includes(cur)) select.value = cur;
}

function populateBankOptions(ids = []) {
  ids.forEach(id => {
    const select = $(`#${id}`);
    if (!select) return;
    const cur = select.value;
    select.innerHTML = `<option value="">เลือกธนาคาร</option>` + appState.banks.map(b => `<option value="${escapeAttr(b.bank_name)}">${escapeHtml(b.bank_name)}</option>`).join("");
    if (appState.banks.some(b => b.bank_name === cur)) select.value = cur;
  });
}

function populateServiceCostOptions(ids = []) {
  const active = appState.serviceCosts.filter(r=>r.is_active);
  ids.forEach(id => {
    const select = $(`#${id}`);
    if (!select) return;
    const cur = select.value;
    select.innerHTML = `<option value="">เลือกต้นทุนบริการ</option>` + active.map(r => `<option value="${escapeAttr(r.id)}">${escapeHtml(r.name)}</option>`).join("");
    if (active.some(r => r.id === cur)) select.value = cur;
  });
}

function syncItemsByCategory(categorySelectId, itemSelectId) {
  const category = $(`#${categorySelectId}`)?.value || "";
  const itemSelect = $(`#${itemSelectId}`);
  if (!itemSelect) return;
  const cur = itemSelect.value;
  const filtered = appState.expenseMaster.filter(r => !category || r.category === category);
  itemSelect.innerHTML = `<option value="">เลือกรายการเบิก</option>` + filtered.map(r => `<option value="${escapeAttr(r.item)}">${escapeHtml(r.item)}</option>`).join("");
  if (filtered.some(r => r.item === cur)) itemSelect.value = cur;
}

function syncMasterIntoForm(itemSelectId, { topicId, guideTextId, serviceCostSelectId }) {
  const item = $(`#${itemSelectId}`)?.value || "";
  const master = getMasterByItem(item);
  if (!master) {
    if ($(`#${topicId}`)) $(`#${topicId}`).value = "";
    if ($(`#${guideTextId}`)) setText(guideTextId, "เลือกรายการเบิกก่อน ระบบจะแสดงคำแนะนำเอกสารอัตโนมัติ");
    return;
  }
  if ($(`#${topicId}`)) $(`#${topicId}`).value = master.topic || "";
  if ($(`#${guideTextId}`)) setText(guideTextId, master.guide || "-");
  if ($(`#${serviceCostSelectId}`) && master.service_cost_id) $(`#${serviceCostSelectId}`).value = master.service_cost_id;
}

function updateLoginRoleOptions() {
  const select = $("#loginRole");
  if (!select) return;
  const cur = select.value || "admin";
  select.innerHTML = rolePermissions.map(r => `<option value="${r.key}">${r.label}</option>`).join("");
  select.value = cur;
}

function updateUserRoleOptions() {
  const select = $("#userRole");
  if (!select) return;
  const cur = select.value || "staff";
  select.innerHTML = rolePermissions.map(r => `<option value="${r.key}">${r.label}</option>`).join("");
  select.value = cur;
}

// ============================================================
// PERMISSIONS + NAVIGATION
// ============================================================
function applyRolePermissions() {
  const role = rolePermissions.find(r => r.key === appState.currentUser?.role);
  if (!role) return;
  $$(".menu-item[data-page]").forEach(btn => {
    const allow = !!role.permissions[pageIdToPermission(btn.dataset.page)];
    btn.classList.toggle("disabled", !allow);
    btn.disabled = !allow;
  });
}

function hasPermission(permissionKey) {
  const role = rolePermissions.find(r => r.key === appState.currentUser?.role);
  return !!role?.permissions?.[permissionKey];
}

function pageIdToPermission(pageId) {
  return { "dashboard-page":"dashboard","expense-page":"expense","freight-page":"freight","statement-page":"statement","documents-page":"documents","settings-page":"settings","users-page":"users","logs-page":"logs","revenue-page":"revenue" }[pageId] || "dashboard";
}

function showLoginScreen() {
  $("#loginScreen")?.classList.remove("is-hidden");
  $("#appShell")?.classList.add("is-hidden");
}

function showApp() {
  $("#loginScreen")?.classList.add("is-hidden");
  $("#appShell")?.classList.remove("is-hidden");
}

function updateCurrentUserUI() {
  const user = appState.currentUser;
  if (!user) return;
  setText("currentUserName", user.full_name);
  setText("currentUserRoleText", getRoleLabel(user.role));
  setText("topbarUserName", user.full_name);
  const avatar = (user.full_name||"U").charAt(0).toUpperCase();
  setText("currentUserAvatar", avatar);
  setText("topbarUserAvatar", avatar);
}

function setActivePage(pageId) {
  appState.activePage = pageId;
  $$(".page-section").forEach(p => p.classList.remove("active"));
  $$(".menu-item[data-page]").forEach(i => i.classList.remove("active"));
  $(`#${pageId}`)?.classList.add("active");
  $(`.menu-item[data-page="${pageId}"]`)?.classList.add("active");

  const titleMap = {
    "dashboard-page": { title:"ระบบรายจ่ายต้นทุน", subtitle:"ภาพรวมคาร์โก้ + เฟรท + รายรับ + กำไร/ขาดทุน" },
    "expense-page": { title:"เบิกเงินคาร์โก้", subtitle:"รายการเดี่ยว ไม่ผูก Shipment" },
    "freight-page": { title:"เบิกเงินเฟรท", subtitle:"สร้าง Shipment แล้วเพิ่มรายการเบิกย่อย" },
    "statement-page": { title:"เทียบ Statement", subtitle:"อัปโหลด KBIZ CSV + จับคู่คาร์โก้และเฟรท" },
    "documents-page": { title:"พิมพ์ชุดเอกสาร", subtitle:"ตรวจเอกสารแนบก่อนพิมพ์ชุดงาน" },
    "revenue-page": { title:"รายรับ / กำไรต่อ Shipment", subtitle:"บันทึกยอดลูกค้าจ่าย • ลูกหนี้ค้างรับ • กำไรขั้นต้นต่อ Shipment • ใบหัก ณ ที่จ่ายจากลูกค้า" },
    "settings-page": { title:"ตั้งค่า", subtitle:"Role / Master / ต้นทุนบริการ / ธนาคาร / ภาษี" },
    "users-page": { title:"ผู้ใช้งาน / สิทธิ์", subtitle:"จัดการผู้ใช้และสิทธิ์การเข้าใช้" },
    "logs-page": { title:"ประวัติการทำรายการ", subtitle:"ตรวจสอบการเข้าใช้และการทำรายการย้อนหลัง" }
  };
  const meta = titleMap[pageId] || titleMap["dashboard-page"];
  setText("dynamicPageTitle", meta.title);
  setText("dynamicPageSubtitle", meta.subtitle);
  $("#sidebar")?.classList.remove("is-open");

  if (pageId === "logs-page") renderLogTable();
  if (pageId === "revenue-page") renderRevenueTable();
}

function openModal(id) { $(`#${id}`)?.classList.add("is-open"); }
function closeModal(id) { $(`#${id}`)?.classList.remove("is-open"); }
function bindSimpleOpenButton(buttonId, modalId) {
  const button = $(`#${buttonId}`);
  if (button) button.addEventListener("click", () => openModal(modalId));
}

// ============================================================
// SHIPMENT SELECTION
// ============================================================
function selectShipment(shipmentId) {
  appState.selectedShipmentId = shipmentId;
  renderAllTables();
  syncSelectedShipmentToFreightModal();
}

function updateSelectedShipmentSummary() {
  const box = $("#selectedShipmentSummary");
  const addBtn = $("#openCreateFreightItemModal");
  const shipment = getShipmentById(appState.selectedShipmentId);
  if (!box) return;
  if (!shipment) {
    box.innerHTML = `<strong>ยังไม่ได้เลือก Shipment</strong><span>กรุณาเลือก Shipment จากตารางด้านบนก่อนเพิ่มรายการย่อย</span>`;
    if (addBtn) addBtn.disabled = true;
    return;
  }
  const items = getFreightItemsByShipmentId(shipment.id);
  const total = items.reduce((s,r) => s+Number(r.amount_requested||0), 0);
  box.innerHTML = `<strong>${shipment.shipment_no}</strong><span>${escapeHtml(shipment.customer_name)} • ${items.length} รายการ • ${formatCurrency(total)}</span>`;
  if (addBtn) addBtn.disabled = false;
}

function syncSelectedShipmentToFreightModal() {
  const shipment = getShipmentById(appState.selectedShipmentId);
  if (!shipment) {
    if ($("#freightItemShipmentId")) $("#freightItemShipmentId").value = "";
    setText("freightItemSelectedShipmentText","ยังไม่ได้เลือก Shipment");
    return;
  }
  if ($("#freightItemShipmentId")) $("#freightItemShipmentId").value = shipment.id;
  setText("freightItemSelectedShipmentText",`${shipment.shipment_no} • ${shipment.customer_name}`);
}

// ============================================================
// DETAIL MODALS
// ============================================================
function openShipmentDetail(shipmentId) {
  const shipment = getShipmentById(shipmentId);
  if (!shipment) return;
  const items = getFreightItemsByShipmentId(shipment.id);
  const totalCost = items.reduce((s,r) => s+Number(r.amount_requested||0), 0);
  const revsForShipment = appState.revenues.filter(r => r.shipment_id === shipment.id);
  const totalRev = revsForShipment.reduce((s,r) => s+Number(r.amount_charged||0), 0);
  const profit = totalRev - totalCost;

  const html = `
    <div class="detail-section">
      <h4>ข้อมูล Shipment</h4>
      <div class="detail-grid">
        <div class="detail-item"><span>Shipment No.</span><strong>${shipment.shipment_no}</strong></div>
        <div class="detail-item"><span>วันที่</span><strong>${formatDate(shipment.date)}</strong></div>
        <div class="detail-item"><span>ลูกค้า</span><strong>${escapeHtml(shipment.customer_name)}</strong></div>
        <div class="detail-item"><span>ประเภทขนส่ง</span><strong>${transportText(shipment.transport_type)}</strong></div>
        <div class="detail-item"><span>Term</span><strong>${escapeHtml(shipment.term||"-")}</strong></div>
        <div class="detail-item"><span>เส้นทาง</span><strong>${escapeHtml(`${shipment.origin||"-"} → ${shipment.destination||"-"}`)}</strong></div>
        <div class="detail-item"><span>สถานะ</span><strong>${statusText(shipment.status)}</strong></div>
        <div class="detail-item"><span>หมายเหตุ</span><strong>${escapeHtml(shipment.note||"-")}</strong></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>สรุปการเงิน</h4>
      <div class="detail-grid">
        <div class="detail-item"><span>รายรับ (ยอดลูกค้าจ่าย)</span><strong class="text-green">${formatCurrency(totalRev)}</strong></div>
        <div class="detail-item"><span>ต้นทุนรวม</span><strong class="text-red">${formatCurrency(totalCost)}</strong></div>
        <div class="detail-item"><span>กำไรขั้นต้น</span><strong class="${profit >= 0 ? "text-green" : "text-red"}">${formatCurrency(profit)}</strong></div>
        <div class="detail-item"><span>จำนวนรายการย่อย</span><strong>${items.length}</strong></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>รายการย่อยภายใต้ Shipment</h4>
      <div class="document-list">
        ${items.length ? items.map(row => `
          <div class="document-row">
            <div class="document-row__meta">
              <strong>${row.req_no} • ${escapeHtml(row.item)}</strong>
              <span>${formatCurrency(row.amount_requested)} • QO: ${row.qo_number||"-"} • ${docStatusText(row)}</span>
            </div>
            <button class="action-btn primary" onclick="openRequestDetail('freight','${row.id}')">ดู</button>
          </div>
        `).join("") : `<div class="empty-state">ยังไม่มีรายการย่อย</div>`}
      </div>
    </div>
    ${revsForShipment.length ? `
    <div class="detail-section">
      <h4>รายรับของ Shipment นี้</h4>
      <div class="document-list">
        ${revsForShipment.map(r => `
          <div class="document-row">
            <div class="document-row__meta">
              <strong>${r.revenue_no||"-"} • ${formatCurrency(r.amount_charged)}</strong>
              <span>รับแล้ว ${formatCurrency(r.amount_received)} • ใบหัก ${r.has_withholding_from_customer ? "✅" : "❌"} • ${revenuStatusBadge(r.status)}</span>
            </div>
          </div>
        `).join("")}
      </div>
    </div>` : ""}
  `;
  $("#requestDetailContent").innerHTML = html;
  openModal("requestDetailModal");
}

function openRequestDetail(mode, id) {
  const row = mode === "freight" ? getFreightItemById(id) : getCargoRequestById(id);
  if (!row) return;
  const shipment = mode === "freight" ? getShipmentById(row.shipment_id) : null;
  const html = `
    <div class="detail-section">
      <h4>ข้อมูลรายการ</h4>
      <div class="detail-grid">
        <div class="detail-item"><span>ประเภท</span><strong>${mode==="freight"?"เบิกเงินเฟรท":"เบิกเงินคาร์โก้"}</strong></div>
        <div class="detail-item"><span>เลขที่รายการ</span><strong>${row.req_no}</strong></div>
        <div class="detail-item"><span>วันที่</span><strong>${formatDate(row.date)}</strong></div>
        <div class="detail-item"><span>Submit เมื่อ</span><strong>${row.submitted_at ? row.submitted_at.replace("T"," ").slice(0,16) : "-"}</strong></div>
        <div class="detail-item"><span>ผู้เบิก</span><strong>${escapeHtml(row.requester)}</strong></div>
        <div class="detail-item"><span>เลข QO</span><strong>${escapeHtml(row.qo_number||"-")}</strong></div>
        <div class="detail-item"><span>Term</span><strong>${escapeHtml(row.term||"-")}</strong></div>
        <div class="detail-item"><span>ประเภทขนส่ง</span><strong>${transportText(row.transport_type)}</strong></div>
        <div class="detail-item"><span>หมวดหมู่</span><strong>${escapeHtml(row.category)}</strong></div>
        <div class="detail-item"><span>รายการเบิก</span><strong>${escapeHtml(row.item)}</strong></div>
        <div class="detail-item"><span>ต้นทุนบริการ</span><strong>${escapeHtml(getServiceCostName(row.service_cost_id))}</strong></div>
        <div class="detail-item"><span>จำนวนเงินขอเบิก</span><strong>${formatCurrency(row.amount_requested)}</strong></div>
        <div class="detail-item"><span>ธนาคาร</span><strong>${escapeHtml(row.bank||"-")}</strong></div>
        <div class="detail-item"><span>บัญชีรับเงิน</span><strong>${escapeHtml(row.account_name||"-")} ${row.account_no?`(${escapeHtml(row.account_no)})`:""}
        </strong></div>
        ${shipment?`<div class="detail-item"><span>Shipment</span><strong>${shipment.shipment_no} • ${escapeHtml(shipment.customer_name)}</strong></div>`:""}
        <div class="detail-item"><span>สลิปที่แนบ</span><strong>${escapeHtml(row.slip_filename||"ยังไม่มีสลิป")}</strong></div>
        <div class="detail-item"><span>สถานะ</span><strong>${statusText(row.status)}</strong></div>
        <div class="detail-item"><span>หมายเหตุ</span><strong>${escapeHtml(row.note||"-")}</strong></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>สถานะเอกสาร</h4>
      <div class="detail-grid">
        <div class="detail-item"><span>ต้องมีใบเสร็จ</span><strong>${row.need_receipt?"ใช่":"ไม่ต้อง"}</strong></div>
        <div class="detail-item"><span>มีใบเสร็จ</span><strong>${row.has_receipt?"✅ มีแล้ว":"❌ ยังไม่มี"}</strong></div>
        <div class="detail-item"><span>ต้องมีสลิป</span><strong>${row.need_slip?"ใช่":"ไม่ต้อง"}</strong></div>
        <div class="detail-item"><span>มีสลิป</span><strong>${row.has_slip?"✅ มีแล้ว":"❌ ยังไม่มี"}</strong></div>
        <div class="detail-item"><span>ต้องมีหัก ณ ที่จ่าย</span><strong>${row.need_withholding?"ใช่":"ไม่ต้อง"}</strong></div>
        <div class="detail-item"><span>มีหัก ณ ที่จ่าย</span><strong>${row.has_withholding?"✅ มีแล้ว":"❌ ยังไม่มี"}</strong></div>
        <div class="detail-item"><span>เอกสารครบ</span><strong>${isDocumentComplete(row)?"✅ ครบ":"❌ ยังไม่ครบ"}</strong></div>
        <div class="detail-item"><span>Statement Match</span><strong>${row.statement_matched?`✅ Matched (${row.statement_match_confidence}%)`:"❌ Unmatched"}</strong></div>
      </div>
    </div>
  `;
  $("#requestDetailContent").innerHTML = html;
  openModal("requestDetailModal");
}

// ============================================================
// DEMO TOGGLES
// ============================================================
async function toggleDemoDocStatus(mode, id) {
  const row = mode === "freight" ? getFreightItemById(id) : getCargoRequestById(id);
  if (!row) return;
  row.has_receipt = row.need_receipt ? !row.has_receipt : false;
  row.has_invoice = row.need_invoice ? !row.has_invoice : false;
  row.has_withholding = row.need_withholding ? !row.has_withholding : false;
  row.has_slip = row.need_slip ? !row.has_slip : false;
  row.status = deriveRowStatus(row);
  try {
    await sb.update("expense_requests", { has_receipt:row.has_receipt, has_invoice:row.has_invoice, has_withholding:row.has_withholding, has_slip:row.has_slip, status:row.status }, { id:row.id });
    await addLog("TOGGLE_DOCS", row.req_no, "สลับสถานะเอกสาร");
    renderAllTables();
    toast("success","อัปเดตเอกสารแล้ว",`ปรับสถานะ ${row.req_no}`);
  } catch(err) { toast("error","บันทึกไม่สำเร็จ",err.message); }
}

async function toggleDemoStatement(mode, id) {
  const row = mode === "freight" ? getFreightItemById(id) : getCargoRequestById(id);
  if (!row) return;
  row.statement_matched = !row.statement_matched;
  row.statement_match_confidence = row.statement_matched ? 90 : 0;
  row.status = deriveRowStatus(row);
  try {
    await sb.update("expense_requests", { statement_matched:row.statement_matched, statement_match_confidence:row.statement_match_confidence, status:row.status }, { id:row.id });
    await addLog("TOGGLE_STATEMENT", row.req_no, "สลับสถานะ Statement");
    renderAllTables();
    toast("success","อัปเดต Statement แล้ว",`${row.req_no}`);
  } catch(err) { toast("error","บันทึกไม่สำเร็จ",err.message); }
}

// ============================================================
// FILTERS
// ============================================================
function applyCargoFilters(rows) {
  const search = ($("#globalSearch")?.value||"").trim().toLowerCase();
  const localSearch = ($("#expenseSearchInput")?.value||"").trim().toLowerCase();
  const category = $("#expenseCategoryFilter")?.value||"";
  const item = $("#expenseItemFilter")?.value||"";
  const docStatus = $("#expenseDocStatusFilter")?.value||"";
  const stmtStatus = $("#expenseStatementFilter")?.value||"";
  const transferStatus = $("#expenseTransferFilter")?.value||"";
  const source = $("#expenseSourceFilter")?.value||"";

  return rows.filter(row => {
    const h = [row.req_no,row.requester,row.category,row.item,row.topic,row.bank,row.note,row.qo_number,row.container_flight_no,row.withholding_no].join(" ").toLowerCase();
    const matchGlobal = !search || h.includes(search);
    const matchLocal = !localSearch || h.includes(localSearch);
    const matchCategory = !category || row.category === category;
    const matchItem = !item || row.item === item;
    const matchDoc = !docStatus || (docStatus==="complete" && isDocumentComplete(row)) || (docStatus==="incomplete" && hasAnyAttachedDoc(row) && !isDocumentComplete(row)) || (docStatus==="pending" && !hasAnyAttachedDoc(row));
    const matchStmt = !stmtStatus || (stmtStatus==="matched" && row.statement_matched) || (stmtStatus==="unmatched" && !row.statement_matched);
    const matchTransfer = !transferStatus || row.transfer_status === transferStatus;
    const matchSource = !source || (row.source||"web") === source;
    return matchGlobal && matchLocal && matchCategory && matchItem && matchDoc && matchStmt && matchTransfer && matchSource;
  });
}

function applyFreightShipmentFilters(rows) {
  const search = ($("#globalSearch")?.value||"").trim().toLowerCase();
  const localSearch = ($("#freightSearchInput")?.value||"").trim().toLowerCase();
  const transport = $("#freightTransportFilter")?.value||"";
  const status = $("#freightStatusFilter")?.value||"";
  const docFilter = $("#freightDocFilter")?.value||"";

  return rows.filter(shipment => {
    const items = getFreightItemsByShipmentId(shipment.id);
    const allComplete = items.length ? items.every(it=>isDocumentComplete(it)) : false;
    const h = [shipment.shipment_no,shipment.customer_name,shipment.transport_type,shipment.origin,shipment.destination,shipment.note].join(" ").toLowerCase();
    const matchGlobal = !search || h.includes(search);
    const matchLocal = !localSearch || h.includes(localSearch);
    const matchTransport = !transport || shipment.transport_type === transport;
    const matchStatus = !status || shipment.status === status;
    const matchDoc = !docFilter || (docFilter==="complete" && allComplete) || (docFilter==="incomplete" && !allComplete);
    return matchGlobal && matchLocal && matchTransport && matchStatus && matchDoc;
  });
}

// ============================================================
// DATA HELPERS
// ============================================================
function getCargoRequestById(id) { return appState.expenseRequests.find(r=>r.id===id); }
function getFreightItemById(id) { return appState.freightItems.find(r=>r.id===id); }
function getShipmentById(id) { return appState.freightShipments.find(r=>r.id===id); }
function getFreightItemsByShipmentId(sid) { return appState.freightItems.filter(r=>r.shipment_id===sid); }
function getMasterByItem(item) { return appState.expenseMaster.find(r=>r.item===item); }
function getServiceCostName(id) { if (!id) return "-"; return appState.serviceCosts.find(r=>r.id===id)?.name || "-"; }
function getRoleLabel(key) { return rolePermissions.find(r=>r.key===key)?.label || key || "-"; }

function deriveRowStatus(row) {
  if (row.statement_matched && isDocumentComplete(row)) return "reconciled";
  if (!isDocumentComplete(row) && hasAnyAttachedDoc(row)) return "docs_incomplete";
  if (!isDocumentComplete(row)) return "docs_pending";
  if (isDocumentComplete(row) && !row.statement_matched) return "waiting_statement";
  return "draft";
}

function isDocumentComplete(row) {
  return (!row.need_receipt || row.has_receipt) && (!row.need_invoice || row.has_invoice) && (!row.need_withholding || row.has_withholding) && (!row.need_slip || row.has_slip);
}
function hasAnyAttachedDoc(row) { return !!(row.has_receipt||row.has_invoice||row.has_withholding||row.has_slip); }
function getRequiredDocLabels(row) { const l=[]; if(row.need_receipt)l.push("ใบเสร็จ"); if(row.need_invoice)l.push("ใบกำกับ"); if(row.need_withholding)l.push("หัก ณ ที่จ่าย"); if(row.need_slip)l.push("สลิป"); return l; }
function getAttachedDocLabels(row) { const l=[]; if(row.has_receipt)l.push("ใบเสร็จ"); if(row.has_invoice)l.push("ใบกำกับ"); if(row.has_withholding)l.push("หัก ณ ที่จ่าย"); if(row.has_slip)l.push("สลิป"); return l; }

// ============================================================
// BADGES
// ============================================================
function badge(text, color="gray") { return `<span class="badge ${color}">${escapeHtml(String(text))}</span>`; }
function boolBadge(v) { return v ? badge("ใช่","green") : badge("ไม่","gray"); }
function confidenceBadge(c) { const n=Number(c||0); if(n>=90)return badge(`${n}%`,"green"); if(n>=70)return badge(`${n}%`,"yellow"); return badge(`${n}%`,"red"); }
function docStatusBadge(row) { if(isDocumentComplete(row))return badge("ครบ","green"); if(hasAnyAttachedDoc(row))return badge("ไม่ครบ","yellow"); return badge("รอเอกสาร","red"); }
function docStatusText(row) { if(isDocumentComplete(row))return "ครบ"; if(hasAnyAttachedDoc(row))return "ไม่ครบ"; return "รอเอกสาร"; }
function statusBadge(status) { const text=statusText(status); if(["reconciled","active","received"].includes(status))return badge(text,"green"); if(["docs_pending","docs_incomplete","draft","waiting_statement","pending"].includes(status))return badge(text,"yellow"); if(status==="closed")return badge(text,"blue"); return badge(text,"gray"); }
function statusText(status) { return {"draft":"Draft","active":"Active","closed":"Closed","reconciled":"กระทบยอดแล้ว","docs_pending":"รอเอกสาร","docs_incomplete":"เอกสารไม่ครบ","waiting_statement":"รอเทียบ Statement","pending":"รอรับชำระ","received":"รับชำระแล้ว","partial":"รับบางส่วน"}[status]||status||"-"; }
function transportBadge(key) { if(key==="sea")return badge("🚢 เรือ","blue"); if(key==="truck")return badge("🚛 รถ","yellow"); if(key==="air")return badge("✈️ แอร์","red"); return badge("-","gray"); }
function transportText(key) { return {sea:"เรือ",truck:"รถ",air:"แอร์"}[key]||key||"-"; }
function directionBadge(dir) { if(dir==="in")return badge("เงินเข้า","green"); if(dir==="out")return badge("เงินออก","red"); return badge("ค่าธรรมเนียม","gray"); }
function revenuStatusBadge(status) { if(status==="received")return badge("รับชำระแล้ว","green"); if(status==="partial")return badge("รับบางส่วน","yellow"); return badge("รอรับชำระ","red"); }

// Phase 4: transfer status badge — ตรงกับ Excel จริง
function transferStatusBadge(s) {
  if (!s) return badge("ยังไม่ระบุ","gray");
  const map = {
    "โอนแล้ว":    ["โอนแล้ว ✅","green"],
    "ต้องการเบิก":["ต้องการเบิก","yellow"],
    "ไม่มีโอน":   ["ไม่มีโอน","gray"],
    "รอโอน":      ["รอโอน","yellow"],
  };
  const [label, color] = map[s] || [s,"gray"];
  return badge(label, color);
}

// Phase 4: receipt status badge
function receiptStatusBadge(s) {
  if (!s) return badge("-","gray");
  if (s.includes("ไม่มีใบเสร็จ") || s.includes("รอ")) return badge(s,"yellow");
  if (s.includes("ครบ") || s.includes("ได้รับ")) return badge(s,"green");
  return badge(s,"gray");
}

// Phase 4: cycle transfer status ผ่าน 4 สถานะ
async function cycleTransferStatus(mode, id) {
  const row = mode === "freight" ? getFreightItemById(id) : getCargoRequestById(id);
  if (!row) return;
  const cycle = ["ต้องการเบิก","รอโอน","โอนแล้ว","ไม่มีโอน"];
  const cur = row.transfer_status || "ต้องการเบิก";
  const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
  row.transfer_status = next;
  if (next === "โอนแล้ว") { row.status = deriveRowStatus(row); }
  try {
    await sb.update("expense_requests", { transfer_status: next, status: row.status }, { id: row.id });
    await addLog("UPDATE_TRANSFER_STATUS", row.req_no, `สถานะโอน: ${cur} → ${next}`);
    renderAllTables();
    toast("success","อัปเดตสถานะโอนเงิน",`${row.req_no} → ${next}`);
  } catch(e) { renderAllTables(); }
}

// ============================================================
// LOG
// ============================================================
async function addLog(action, refNo, detail) {
  try {
    await sb.insert("logs", { id: generateId("log"), user_name: appState.currentUser?.full_name || "System", user_role: appState.currentUser?.role || "system", action, ref_no: refNo, detail });
  } catch(e) { console.warn("Log insert failed:", e.message); }
}

// ============================================================
// UTILS
// ============================================================
function initDefaultDates() {
  ["requestDate","shipmentDate","freightItemDate","revenueDate"].forEach(id => {
    const el = $(`#${id}`);
    if (el && !el.value) el.value = todayISO();
  });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function formatDate(dateStr) { return dateStr||"-"; }

function formatCurrency(value) {
  const num = Number(value||0);
  return `฿${num.toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}

function generateId(prefix="id") { return `${prefix}-${Math.random().toString(36).slice(2,9)}-${Date.now().toString(36)}`; }

function generateReqNo(mode="cargo") {
  const source = mode==="freight" ? appState.freightItems : appState.expenseRequests;
  const max = source.reduce((acc,row) => { const raw = String(row.req_no||"").match(/(\d+)$/); return Math.max(acc, raw ? Number(raw[1]) : 0); }, 0);
  const next = String(max+1).padStart(4,"0");
  return mode==="freight" ? `FRQ-2026-${next}` : `REQ-2026-${next}`;
}

function generateShipmentNo() {
  const max = appState.freightShipments.reduce((acc,row) => { const raw = String(row.shipment_no||"").match(/(\d+)$/); return Math.max(acc, raw ? Number(raw[1]) : 0); }, 0);
  return `SHP-2026-${String(max+1).padStart(4,"0")}`;
}

function generateRevenueNo() {
  const max = appState.revenues.reduce((acc,row) => { const raw = String(row.revenue_no||"").match(/(\d+)$/); return Math.max(acc, raw ? Number(raw[1]) : 0); }, 0);
  return `REV-2026-${String(max+1).padStart(4,"0")}`;
}

function toast(type="success", title="", message="") {
  const stack = $("#toastStack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function setText(id, value) { const el = $(`#${id}`); if(el) el.textContent = value??""; }
function $(s) { return document.querySelector(s); }
function $$(s) { return [...document.querySelectorAll(s)]; }
function escapeHtml(v) { return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;"); }
function escapeAttr(v) { return escapeHtml(v); }
function escapeJs(v) { return String(v??"").replaceAll("'","\\'"); }

// Expose globals for inline onclick
window.selectShipment = selectShipment;
window.openRequestDetail = openRequestDetail;
window.openShipmentDetail = openShipmentDetail;
window.openRevenueDetail = openRevenueDetail;
window.markRevenueReceived = markRevenueReceived;
window.toggleRevenueWithholding = toggleRevenueWithholding;
window.toggleDemoDocStatus = toggleDemoDocStatus;
window.toggleDemoStatement = toggleDemoStatement;
window.cycleTransferStatus = cycleTransferStatus;
window.toast = toast;

// ============================================================
// GOOGLE SHEETS → SUPABASE BRIDGE (Phase 4)
// ============================================================
// วิธีใช้:
// 1. เปิด Google Sheets ที่พนักงานใช้ (เบิกเงินทำงาน SEA/AIR/TRUCK/CARGO)
// 2. เปิด Apps Script (Extensions → Apps Script)
// 3. วาง code APPS_SCRIPT_CODE ด้านล่างนี้ลงใน Code.gs
// 4. Deploy as Web App → Execute as: Me, Who has access: Anyone
// 5. Copy URL ไปกรอกใน SHEETS_WEBHOOK_URL ด้านล่าง
// 6. พนักงานกรอก Sheet → กด "ส่งข้อมูลไประบบ" → ข้อมูลเข้า Supabase ทันที
// ============================================================

const APPS_SCRIPT_CODE = `
// ==========================================
// Google Apps Script — PCS Accounting Bridge
// วาง code นี้ใน Apps Script แล้ว Deploy as Web App
// ==========================================

const SUPABASE_URL = "${SUPABASE_URL}";
const SUPABASE_KEY = "${SUPABASE_ANON_KEY}";

// ทำงานเมื่อมีการเรียก POST (จาก Sheet หรือ trigger)
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const result = pushToSupabase(payload);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ดึงข้อมูลจาก Sheet และส่งไป Supabase
function syncSheetToSupabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // วนทุก sheet ที่ชื่อขึ้นต้นด้วย "เบิกเงิน" หรือ "SHIP"
  const sheetNames = ["SHIP ต้องการเบิก","Axelra เบิกเงินทำงานSEA","Axelra เบิกเงินทำงานAIR","Axelra เบิกเงินทำงานTRUCK","NNB เบิกเงินทำงาน ตู้เรือ SEA #","NNB เบิกเงินทำงาน ตู้รถ TRUCK #"];
  
  sheetNames.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    const headers = data[2]; // row 3 เป็น header จริง (0-indexed = row index 2)
    
    for (let i = 3; i < data.length; i++) {
      const row = data[i];
      if (!row[1] && !row[2]) continue; // skip empty rows
      
      const dateVal = row[1];
      const dateISO = dateVal instanceof Date ? Utilities.formatDate(dateVal, "Asia/Bangkok", "yyyy-MM-dd") : String(dateVal||"").substring(0,10);
      
      const record = {
        id: "sheets-" + name.replace(/[^a-zA-Z0-9]/g,"") + "-row" + i,
        req_no: "SHEET-" + i,
        mode: name.includes("CARGO") ? "cargo" : "freight",
        source: "sheets",
        sheet_name: name,
        date: dateISO,
        requester: String(row[2] || ""),
        shipment_id: null,
        qo_number: String(row[4] || ""),
        category: String(row[5] || "ต้นทุนบริการ"),
        item: String(row[6] || ""),
        note: String(row[7] || ""),
        amount_requested: parseFloat(String(row[8]||"0").replace(/,/g,"")) || 0,
        amount_refund: parseFloat(String(row[9]||"0").replace(/,/g,"")) || 0,
        account_name: String(row[11] || ""),
        account_no: String(row[12] || ""),
        bank: String(row[13] || ""),
        transfer_status: String(row[14] || "ต้องการเบิก"),
        withholding_no: String(row[17] || ""),
        receipt_status: String(row[16] || ""),
        status: "draft",
        need_receipt: false, need_slip: false, need_withholding: false, need_invoice: false,
        has_receipt: false, has_slip: false, has_withholding: false, has_invoice: false,
        statement_matched: false, statement_match_confidence: 0,
        amount_approved: parseFloat(String(row[8]||"0").replace(/,/g,"")) || 0,
        amount_used: 0, amount_covered: 0
      };
      
      pushToSupabase(record);
    }
  });
  
  SpreadsheetApp.getUi().alert("✅ ส่งข้อมูลไประบบบัญชีสำเร็จ!");
}

function pushToSupabase(record) {
  const url = SUPABASE_URL + "/rest/v1/expense_requests";
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    payload: JSON.stringify([record]),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  return { status: response.getResponseCode(), body: response.getContentText().substring(0,200) };
}

// เพิ่ม custom menu ใน Google Sheets
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📊 ระบบบัญชี PCS")
    .addItem("ส่งข้อมูลไประบบบัญชี", "syncSheetToSupabase")
    .addToUi();
}
`;

// =====================================================
// แสดง Apps Script ให้ Admin copy ไปใช้
// =====================================================
window.showAppsScriptGuide = function() {
  const html = `
    <div class="detail-section">
      <h4>📋 วิธีตั้งค่า Google Sheets → ระบบ (Realtime)</h4>
      <div style="background:#f8f9fa;border-radius:12px;padding:16px;margin-top:12px;">
        <p style="margin:0 0 12px;color:#344054;font-weight:700;">ขั้นตอน:</p>
        <ol style="margin:0;padding-left:20px;line-height:2;color:#475467;">
          <li>เปิด Google Sheets ที่พนักงานใช้กรอกเบิกเงิน</li>
          <li>ไปที่ <strong>Extensions → Apps Script</strong></li>
          <li>วาง Code ด้านล่างนี้ใน <strong>Code.gs</strong></li>
          <li>กด <strong>Deploy → New Deployment → Web App</strong></li>
          <li>ตั้ง Execute as: <strong>Me</strong>, Who has access: <strong>Anyone</strong></li>
          <li>Copy URL ที่ได้ไปแจ้งทีม IT</li>
        </ol>
        <p style="margin:12px 0 8px;color:#344054;font-weight:700;">ผล: พนักงานกด "📊 ระบบบัญชี PCS → ส่งข้อมูลไประบบบัญชี" จาก Sheet → ข้อมูลเข้าระบบทันที</p>
      </div>
      <div style="margin-top:16px;">
        <strong style="color:var(--pcs-red-2);">Apps Script Code (Copy ทั้งหมด):</strong>
        <pre style="background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:16px;margin-top:8px;overflow:auto;font-size:12px;max-height:300px;">${escapeHtml(APPS_SCRIPT_CODE)}</pre>
        <button class="btn btn-primary" style="margin-top:12px" onclick="navigator.clipboard.writeText(window.APPS_SCRIPT_CODE_RAW||'').then(()=>toast('success','คัดลอกแล้ว',''))">📋 คัดลอก Code</button>
      </div>
    </div>
  `;
  window.APPS_SCRIPT_CODE_RAW = APPS_SCRIPT_CODE;
  $("#requestDetailContent").innerHTML = html;
  openModal("requestDetailModal");
};
""
