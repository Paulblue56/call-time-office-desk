(() => {
  "use strict";

  const STORAGE_KEY = "call-time-office-desk-v1";
  const WORK_ACCOUNT_KEY = "call-time-work-directory-settings-v1";
  const CLOUD_CONFIG_KEY = "call-time-cloud-config-v1";
  const CLOUD_SESSION_KEY = "call-time-cloud-session-v1";
  const CLOUD_TOMBSTONES_KEY = "call-time-cloud-tombstones-v1";
  const ASSISTANT_FUNCTION_PATH = "/functions/v1/gemini-assistant";
  const ASSISTANT_MAX_PROMPT_LENGTH = 2000;
  const DEFAULT_CLOUD_CONFIG = {
    url: "https://uuccjydofzhieyuigyvo.supabase.co",
    anonKey: "sb_publishable_bI9DDR00BWbJHMrdaLMiUw_ZDujl4pR"
  };
  const WORK_DIRECTORY_SCOPE = "User.ReadBasic.All";
  const today = toDateInput(new Date());
  let storageFault = false;
  let msalClientPromise;
  const state = {
    view: "overview",
    overviewDay: today,
    callFilter: "all",
    callSearch: "",
    directorySearch: "",
    directoryPage: 0,
    staffSearch: "",
    staffResults: [],
    staffSearchStatus: "",
    attendanceDay: today,
    reportStart: mondayOf(today),
    meetingImportStatus: "",
    assistantMessages: [],
    assistantBusy: false,
    data: loadData()
  };
  let localDataSnapshot = JSON.stringify(state.data);
  let cloudConfig = loadCloudConfig();
  let cloudSession = loadCloudSession();
  let cloudSyncStatus = cloudSession ? "Checking cloud storage…" : "Device only";
  let cloudSyncTimer;
  let cloudSyncPromise;
  let cloudTombstones = loadCloudTombstones();
  let authCallback = readAuthCallback();
  let deferredInstallPrompt;

  const content = document.querySelector("#content");
  const modalRoot = document.querySelector("#modal-root");
  const sectionTitles = {
    overview: "Overview",
    calls: "Call log",
    attendance: "Attendance",
    meetings: "Meetings",
    directory: "Directory",
    "call-report": "Weekly calls",
    "attendance-report": "Weekly attendance",
    assistant: "Assistant"
  };

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { calls: [], attendance: [], meetings: [], clients: [], staff: [] };
      const saved = JSON.parse(raw);
      const collections = ["calls", "attendance", "meetings", "clients", "staff"];
      if (!saved || !collections.every((key) => Array.isArray(saved[key]))) {
        throw new Error("Saved data is missing one or more expected lists.");
      }
      return {
        calls: saved.calls,
        attendance: saved.attendance,
        meetings: saved.meetings,
        clients: saved.clients,
        staff: saved.staff
      };
    } catch (error) {
      console.error("Could not read saved Call & Time data.", error);
      storageFault = true;
      window.setTimeout(() => toast("Saved data could not be read. Restore a valid backup before making changes."), 0);
      return { calls: [], attendance: [], meetings: [], clients: [], staff: [] };
    }
  }

  function loadWorkAccountSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(WORK_ACCOUNT_KEY) || "null");
      if (settings && typeof settings.tenantId === "string" && typeof settings.clientId === "string") {
        return { tenantId: settings.tenantId.trim(), clientId: settings.clientId.trim() };
      }
    } catch (error) {
      console.error("Could not read the work directory configuration.", error);
    }
    return { tenantId: "", clientId: "" };
  }

  const workAccountSettings = loadWorkAccountSettings();

  function loadCloudConfig() {
    try {
      const config = JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY) || "null");
      if (config && typeof config.url === "string" && typeof config.anonKey === "string") return config;
    } catch (error) {
      console.error("Could not read the cloud storage configuration.", error);
    }
    return DEFAULT_CLOUD_CONFIG;
  }

  function readAuthCallback() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const type = params.get("type");
    if (accessToken && refreshToken && ["invite", "recovery", "signup"].includes(type)) {
      return {
        accessToken,
        refreshToken,
        expiresAt: Number(params.get("expires_at")) || Math.floor(Date.now() / 1000) + Number(params.get("expires_in") || 3600),
        type
      };
    }
    const error = new URLSearchParams(window.location.search).get("error_description");
    if (error) window.setTimeout(() => toast(`Authentication link error: ${error.replace(/\+/g, " ")}`), 0);
    return null;
  }

  function loadCloudSession() {
    try {
      const session = JSON.parse(localStorage.getItem(CLOUD_SESSION_KEY) || "null");
      if (session && typeof session.access_token === "string" && session.user?.id) return session;
    } catch (error) {
      console.error("Could not read the cloud storage session.", error);
    }
    return null;
  }

  function loadCloudTombstones() {
    try {
      const saved = JSON.parse(localStorage.getItem(CLOUD_TOMBSTONES_KEY) || "[]");
      if (Array.isArray(saved) && saved.every((item) => typeof item === "string" ||
        (item && Array.isArray(item.keys) && item.keys.every((key) => typeof key === "string") &&
          item.keys.length > 0 && typeof item.deletedAt === "string" && Number.isFinite(Date.parse(item.deletedAt))))) {
        return saved.map((item) => typeof item === "string"
          ? { keys: [item], deletedAt: "1970-01-01T00:00:00.000Z" }
          : item);
      }
      throw new Error("Saved deletion markers are invalid.");
    } catch (error) {
      console.error("Could not read cloud deletion markers.", error);
      return [];
    }
  }

  function persistCloudTombstones() {
    try {
      localStorage.setItem(CLOUD_TOMBSTONES_KEY, JSON.stringify(cloudTombstones));
    } catch (error) {
      console.error("Could not save cloud deletion markers.", error);
      toast("Could not save a cloud deletion marker on this device.");
      return false;
    }
    return true;
  }

  function persistLocalData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
      localDataSnapshot = JSON.stringify(state.data);
      return true;
    } catch (error) {
      console.error("Could not save Call & Time data.", error);
      toast("Could not save data. Check browser storage space.");
      return false;
    }
  }

  function saveData(allowRecovery = false) {
    if (storageFault && !allowRecovery) {
      toast("Saved data could not be read, so changes were not saved. Restore a valid backup to continue.");
      return false;
    }
    reconcileCompletedCallbacks();
    stampLocalDataChanges();
    if (!persistLocalData()) return false;
    if (allowRecovery) storageFault = false;
    clearCloudTombstonesForCurrentRecords();
    persistCloudTombstones();
    scheduleCloudSync();
    return true;
  }

  function stampLocalDataChanges() {
    let previous;
    try {
      previous = JSON.parse(localDataSnapshot);
    } catch (error) {
      console.error("Could not compare the previous local data snapshot.", error);
      previous = { calls: [], attendance: [], meetings: [], clients: [], staff: [] };
    }
    const changedAt = new Date().toISOString();
    for (const collection of ["calls", "attendance", "meetings", "clients", "staff"]) {
      const before = new Map((previous[collection] || []).map((record) => [record.id, record]));
      for (const record of state.data[collection]) {
        const oldRecord = before.get(record.id);
        const oldValue = oldRecord ? { ...oldRecord } : null;
        const newValue = { ...record };
        if (oldValue) {
          delete oldValue.updatedAt;
          delete newValue.updatedAt;
        }
        if (!oldRecord || JSON.stringify(oldValue) !== JSON.stringify(newValue)) record.updatedAt = changedAt;
      }
    }
  }

  function id() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function toDateInput(date) {
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 10);
  }

  function toTimeInput(date) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function dateFromInput(value) {
    return value ? new Date(`${value}T00:00:00`) : null;
  }

  function mondayOf(dateValue) {
    const date = dateFromInput(dateValue) || new Date();
    const day = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - day);
    return toDateInput(date);
  }

  function addDays(dateValue, days) {
    const date = dateFromInput(dateValue);
    date.setDate(date.getDate() + days);
    return toDateInput(date);
  }

  function formatDate(value, options = { day: "numeric", month: "short", year: "numeric" }) {
    const date = dateFromInput(value);
    return date ? new Intl.DateTimeFormat("en-KE", options).format(date) : "—";
  }

  function formatTime(value) {
    if (!value) return "—";
    const [hour, minute] = value.split(":").map(Number);
    return new Intl.DateTimeFormat("en-KE", { hour: "numeric", minute: "2-digit" })
      .format(new Date(2000, 0, 1, hour, minute));
  }

  function formatHours(value) {
    const hours = Number(value);
    return Number.isFinite(hours) ? `${hours.toFixed(2).replace(/\.?0+$/, "")}h` : "—";
  }

  function sortedByNewest(items, dateField = "date", timeField = "time") {
    return [...items].sort((a, b) => `${b[dateField] || ""} ${b[timeField] || ""}`.localeCompare(`${a[dateField] || ""} ${a[timeField] || ""}`));
  }

  function currentWeekCalls(start = state.reportStart) {
    const end = addDays(start, 4);
    return state.data.calls.filter((call) => call.date >= start && call.date <= end);
  }

  function callbackKey(call) {
    const client = normalizedText(call.client);
    const staff = normalizedText(call.staff);
    return client && staff ? `${client}|${staff}` : "";
  }

  function isOpenCallback(call) {
    return /pending|awaiting callback|in progress/i.test(call.followUp || "");
  }

  function isCallbackCompleted(call) {
    return /^callback completed$/i.test((call.followUp || "").trim());
  }

  function isSuccessfulCall(call) {
    return /succeed|success/i.test(call.outcome || "");
  }

  function callTimestamp(call) {
    return `${call.date || ""}T${call.time || "00:00"}`;
  }

  function reconcileCompletedCallbacks() {
    const successfulCalls = state.data.calls.filter(isSuccessfulCall);
    let changed = false;
    state.data.calls.forEach((call) => {
      if (!isOpenCallback(call)) return;
      const key = callbackKey(call);
      if (!key) return;
      const completedLater = successfulCalls.some((success) =>
        success.id !== call.id &&
        callbackKey(success) === key &&
        callTimestamp(success) > callTimestamp(call)
      );
      if (completedLater) {
        call.followUp = "Callback Completed";
        changed = true;
      }
    });
    return changed;
  }

  function pendingCallbackThreads(calls) {
    const threads = new Map();
    calls.filter(isOpenCallback).forEach((call) => {
      const key = callbackKey(call) || call.id;
      const current = threads.get(key);
      if (!current || callTimestamp(call) > callTimestamp(current)) threads.set(key, call);
    });
    return [...threads.values()];
  }

  function pendingCallbackCount(calls) {
    return pendingCallbackThreads(calls).length;
  }

  function currentWeekAttendance(start = state.reportStart) {
    const end = addDays(start, 4);
    return state.data.attendance.filter((entry) => entry.date >= start && entry.date <= end);
  }

  function toast(message) {
    const region = document.querySelector("#toast-region");
    const element = document.createElement("div");
    element.className = "toast";
    element.textContent = message;
    region.append(element);
    window.setTimeout(() => element.remove(), 3200);
  }

  function isInstalledApp() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function setupAppInstallation() {
    const installButton = document.querySelector("#install-app");
    if (!installButton) return;
    installButton.hidden = isInstalledApp();
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      installButton.hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = undefined;
      installButton.hidden = true;
      toast("Call & Time was installed on this device.");
    });
  }

  async function installApp() {
    if (deferredInstallPrompt) {
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = undefined;
      try {
        await promptEvent.prompt();
        const { outcome } = await promptEvent.userChoice;
        if (outcome === "accepted") document.querySelector("#install-app").hidden = true;
      } catch (error) {
        console.error("Could not open the app installation prompt.", error);
        toast("Could not open the installation prompt. Use your browser menu to install this app.");
      }
      return;
    }

    const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isAppleMobile) {
      toast("To install: open this page in Safari, tap Share, then choose Add to Home Screen.");
    } else if (/Android/i.test(navigator.userAgent)) {
      toast("To install: open your browser menu and choose Install app or Add to Home screen.");
    } else {
      toast("To install: use the Install app option in your browser's address bar or menu.");
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !["https:", "http:"].includes(window.location.protocol)) return;
    navigator.serviceWorker.register(new URL("./sw.js", window.location.href))
      .catch((error) => console.error("Could not register the offline app shell.", error));
  }

  function badge(text) {
    const value = String(text || "");
    let style = "";
    if (/succeed|present|complete|not required/i.test(value)) style = " badge-green";
    else if (/pending|partial|leave|sick/i.test(value)) style = " badge-amber";
    else if (/unavailable|unreachable|absent|no answer/i.test(value)) style = " badge-red";
    return `<span class="badge${style}">${escapeHtml(value || "—")}</span>`;
  }

  function statCard(label, value, note, icon) {
    return `<article class="stat-card"><div class="stat-top"><span>${escapeHtml(label)}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-foot">${escapeHtml(note)}</div></article>`;
  }

  function emptyState(title, message) {
    return `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}</div>`;
  }

  function normalizedText(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  }

  function stableRecordKey(collection, record) {
    if (collection === "clients" || collection === "staff") return normalizedText(record.name);
    if (collection === "meetings" && record.externalUid) return `${record.externalUid}|${record.recurrenceId || ""}`;
    return Object.keys(record).filter((key) => key !== "id" && key !== "updatedAt").sort()
      .map((key) => `${key}:${String(record[key] ?? "")}`).join("|");
  }

  function recordTombstoneKeys(collection, record) {
    return [
      record.id ? `${collection}:id:${record.id}` : "",
      `${collection}:key:${stableRecordKey(collection, record)}`
    ].filter(Boolean);
  }

  function mergeTombstoneLists(...lists) {
    const tombstones = new Map();
    lists.flat().forEach((item) => {
      if (!item || !Array.isArray(item.keys) || !item.keys.length) return;
      const key = [...item.keys].sort().join("|");
      const existing = tombstones.get(key);
      if (!existing || Date.parse(item.deletedAt) > Date.parse(existing.deletedAt)) tombstones.set(key, item);
    });
    return [...tombstones.values()];
  }

  function clearCloudTombstonesForCurrentRecords() {
    const activeRecords = Object.entries(state.data).flatMap(([collection, records]) =>
      records.map((record) => ({ keys: recordTombstoneKeys(collection, record), updatedAt: Date.parse(record.updatedAt) || 0 })));
    cloudTombstones = cloudTombstones.filter((tombstone) =>
      !activeRecords.some((record) => record.updatedAt > (Date.parse(tombstone.deletedAt) || 0) &&
        record.keys.some((key) => tombstone.keys.includes(key))));
  }

  function recordTimestamp(record) {
    return Date.parse(record.updatedAt || "") || 0;
  }

  function mergeDataCollections(preferred, secondary) {
    const collections = ["calls", "attendance", "meetings", "clients", "staff"];
    const merged = {};
    for (const collection of collections) {
      const records = [];
      for (const incoming of [...(preferred[collection] || []), ...(secondary[collection] || [])]) {
        if (!incoming || typeof incoming !== "object") continue;
        const key = stableRecordKey(collection, incoming);
        const index = records.findIndex((record) =>
          (incoming.id && record.id === incoming.id) || stableRecordKey(collection, record) === key);
        if (index < 0) {
          records.push({ ...incoming });
          continue;
        }
        const existing = records[index];
        const winner = recordTimestamp(existing) >= recordTimestamp(incoming) ? existing : incoming;
        const other = winner === existing ? incoming : existing;
        const combined = { ...other, ...winner };
        Object.entries(other).forEach(([fieldName, value]) => {
          if ((combined[fieldName] === "" || combined[fieldName] == null) && value != null && value !== "") {
            combined[fieldName] = value;
          }
        });
        if (collection === "clients") {
          const phoneValues = [existing.alternatePhone, incoming.alternatePhone];
          if (existing.phone && incoming.phone && normalizedText(existing.phone) !== normalizedText(incoming.phone)) {
            phoneValues.push(existing.phone, incoming.phone);
          }
          combined.phone = winner.phone || other.phone || "";
          combined.alternatePhone = phoneValues
            .filter((phone) => phone && normalizedText(phone) !== normalizedText(combined.phone))
            .reduce((value, phone) => mergeText(value, phone, " · "), "");
          combined.email = winner.email || other.email || "";
          combined.notes = mergeText(existing.notes, incoming.notes, " | ");
        } else if (collection === "staff") {
          combined.email = winner.email || other.email || "";
          combined.phone = winner.phone || other.phone || "";
        }
        records[index] = combined;
      }
      merged[collection] = records;
    }
    return merged;
  }

  function mergeCloudPayload(localData, remotePayload) {
    const remoteData = remotePayload?.data || remotePayload || {};
    cloudTombstones = mergeTombstoneLists(cloudTombstones,
      Array.isArray(remotePayload?.tombstones) ? remotePayload.tombstones : []);
    const data = mergeDataCollections(localData, remoteData);
    for (const collection of ["calls", "attendance", "meetings", "clients", "staff"]) {
      data[collection] = data[collection].filter((record) => !cloudTombstones.some((tombstone) =>
        Date.parse(tombstone.deletedAt) >= recordTimestamp(record) &&
        recordTombstoneKeys(collection, record).some((key) => tombstone.keys.includes(key))));
    }
    return { data, tombstones: cloudTombstones };
  }

  function updateCloudControls() {
    const status = document.querySelector("#cloud-status");
    const detail = document.querySelector("#cloud-detail");
    const connect = document.querySelector("#cloud-connect");
    const signOut = document.querySelector("#cloud-signout");
    const dot = document.querySelector(".cloud-status-dot");
    if (!status || !detail || !connect || !signOut || !dot) return;
    status.textContent = cloudSession ? "Cloud storage connected" : "Device only";
    detail.textContent = cloudSession
      ? `${cloudSyncStatus} · ${cloudSession.user.email || "Signed in"}`
      : "Set up a free server account";
    connect.lastChild.textContent = cloudSession ? "Sync now" : "Connect cloud storage";
    signOut.hidden = !cloudSession;
    dot.classList.toggle("cloud-connected", Boolean(cloudSession) && !cloudSyncStatus.startsWith("Sync failed"));
  }

  function cloudSetupForm() {
    const projectUrl = cloudConfig?.url || "";
    const anonKey = cloudConfig?.anonKey || "";
    const body = `<div class="form-grid">
      ${field("Supabase project URL", "projectUrl", projectUrl, { required: true, placeholder: "https://your-project.supabase.co", wide: true, hint: "Find this under Project Settings → API. Use the project URL, not a database password." })}
      ${field("Publishable / anon key", "anonKey", anonKey, { required: true, wide: true, hint: "The public client key is protected by database access rules. Never enter a service_role or secret key here." })}
      ${field("Account email", "email", "", { type: "email", required: true, wide: true })}
      ${field("Account password", "password", "", { type: "password", required: true, wide: true, hint: "Create this account in Supabase Authentication first. The password is not saved in this browser." })}
    </div>`;
    openModal("Connect private cloud storage", "Sign in to sync your device data to your Supabase project.", "cloud-login", body, "Sign in and sync");
  }

  function cloudPasswordForm() {
    const action = authCallback?.type === "recovery" ? "reset" : "set";
    const body = `<div class="form-grid">
      <div class="field wide"><label for="cloud-new-password">New password</label><input class="field-control" id="cloud-new-password" name="password" type="password" autocomplete="new-password" minlength="8" required><span class="field-hint">Use at least 8 characters. Your password is sent only to Supabase Auth and is not saved by this website.</span></div>
      <div class="field wide"><label for="cloud-confirm-password">Confirm password</label><input class="field-control" id="cloud-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></div>
    </div>`;
    openModal(action === "reset" ? "Reset your cloud password" : "Set your cloud password",
      "Complete the secure Supabase email link to access your shared workspace.", "cloud-password", body, "Save password");
  }

  async function completeCloudPassword(password) {
    if (!authCallback || !cloudConfig) throw new Error("This authentication link has expired. Request a new email link.");
    const response = await fetch(`${cloudConfig.url}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: cloudConfig.anonKey,
        Authorization: `Bearer ${authCallback.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ password })
    });
    const user = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(user.msg || user.message || user.error_description || "Could not set the cloud password.");
    cloudSession = {
      access_token: authCallback.accessToken,
      refresh_token: authCallback.refreshToken,
      expires_at: authCallback.expiresAt,
      user
    };
    localStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify(cloudSession));
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    authCallback = null;
    await syncCloudData();
  }

  function validateCloudConfig(projectUrl, anonKey) {
    let url;
    try {
      url = new URL(projectUrl);
    } catch {
      throw new Error("Enter a valid Supabase project URL.");
    }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Use the HTTPS Supabase project URL without a path or query.");
    }
    if (!anonKey.trim() || /service[_-]?role|secret/i.test(anonKey)) {
      throw new Error("Enter the public publishable/anon key, never a service_role or secret key.");
    }
    return { url: url.origin, anonKey: anonKey.trim() };
  }

  async function signInCloud(projectUrl, anonKey, email, password) {
    cloudConfig = validateCloudConfig(projectUrl.trim(), anonKey);
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(cloudConfig));
    const response = await fetch(`${cloudConfig.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: cloudConfig.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.msg || result.message || result.error_description || "Could not sign in to Supabase.");
    cloudSession = { ...result, expires_at: result.expires_at || Math.floor(Date.now() / 1000) + result.expires_in };
    localStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify(cloudSession));
    cloudSyncStatus = "Syncing records…";
    updateCloudControls();
    await syncCloudData();
  }

  async function refreshCloudSession() {
    if (!cloudSession || !cloudConfig) throw new Error("Sign in to cloud storage first.");
    if (Number(cloudSession.expires_at) > Math.floor(Date.now() / 1000) + 60) return;
    const response = await fetch(`${cloudConfig.url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: cloudConfig.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: cloudSession.refresh_token })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      cloudSession = null;
      localStorage.removeItem(CLOUD_SESSION_KEY);
      updateCloudControls();
      throw new Error(result.msg || result.message || "Your cloud session expired. Sign in again.");
    }
    cloudSession = { ...result, expires_at: result.expires_at || Math.floor(Date.now() / 1000) + result.expires_in };
    localStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify(cloudSession));
  }

  async function cloudRequest(path, options = {}) {
    if (!cloudConfig || !cloudSession) throw new Error("Connect to your Supabase project and sign in first.");
    await refreshCloudSession();
    const response = await fetch(`${cloudConfig.url}${path}`, {
      ...options,
      headers: {
        apikey: cloudConfig.anonKey,
        Authorization: `Bearer ${cloudSession.access_token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const responseText = await response.text();
    if (!response.ok) {
      let message = responseText;
      try {
        const details = JSON.parse(responseText);
        message = details.message || details.msg || details.hint || details.error || responseText;
      } catch { /* The response may be plain text. */ }
      throw new Error(`Cloud request failed (${response.status}): ${message}`);
    }
    return responseText ? JSON.parse(responseText) : null;
  }

  async function syncCloudData() {
    if (!cloudSession || !cloudConfig) return;
    if (cloudSyncPromise) return cloudSyncPromise;
    cloudSyncPromise = (async () => {
      cloudSyncStatus = "Syncing…";
      updateCloudControls();
      const signedInUserId = cloudSession.user.id;
      const userId = encodeURIComponent(signedInUserId);
      const rows = await cloudRequest(`/rest/v1/call_time_workspace?select=payload&user_id=eq.${userId}`);
      if (!cloudSession || cloudSession.user.id !== signedInUserId) return;
      const remotePayload = rows[0]?.payload || null;
      const merged = mergeCloudPayload(state.data, remotePayload);
      state.data = merged.data;
      reconcileCompletedCallbacks();
      if (!persistLocalData() || !persistCloudTombstones()) {
        throw new Error("Could not save the merged data on this device.");
      }
      const payload = { data: state.data, tombstones: merged.tombstones };
      if (!cloudSession || cloudSession.user.id !== signedInUserId) return;
      await cloudRequest("/rest/v1/call_time_workspace?on_conflict=user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: signedInUserId,
          payload,
          updated_at: new Date().toISOString()
        })
      });
      cloudSyncStatus = `Synced ${new Date().toLocaleTimeString("en-KE", { hour: "numeric", minute: "2-digit" })}`;
      render();
    })().catch((error) => {
      console.error("Could not sync Call & Time data with Supabase.", error);
      cloudSyncStatus = "Sync failed — data remains on this device";
      toast(`Cloud sync failed: ${error.message}`);
      updateCloudControls();
      throw error;
    }).finally(() => {
      cloudSyncPromise = null;
    });
    return cloudSyncPromise;
  }

  function scheduleCloudSync() {
    if (!cloudSession) return;
    window.clearTimeout(cloudSyncTimer);
    cloudSyncTimer = window.setTimeout(() => {
      syncCloudData().catch(() => {});
    }, 500);
  }

  async function signOutCloud() {
    let remoteError;
    try {
      if (cloudSession && cloudConfig) await cloudRequest("/auth/v1/logout", { method: "POST" });
    } catch (error) {
      console.error("Could not revoke the Supabase session.", error);
      remoteError = error;
    } finally {
      cloudSession = null;
      cloudSyncStatus = "Device only";
      localStorage.removeItem(CLOUD_SESSION_KEY);
      updateCloudControls();
    }
    toast(remoteError
      ? `Signed out on this device. Supabase could not revoke the session: ${remoteError.message}`
      : "Signed out. This device's saved data was kept.");
  }

  function initializeCloudSync() {
    updateCloudControls();
    if (authCallback) {
      cloudPasswordForm();
      return;
    }
    if (cloudSession && cloudConfig && navigator.onLine) {
      syncCloudData().catch(() => {});
    }
    if (cloudSession) window.setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible") syncCloudData().catch(() => {});
    }, 30000);
  }

  function pageHeading(eyebrow, title, description, action = "") {
    return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`;
  }

  function render() {
    document.querySelector("#current-section").textContent = sectionTitles[state.view];
    document.querySelector("#today-label").textContent = formatDate(today, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    content.classList.toggle("attendance-report-content", state.view === "attendance-report");
    document.querySelectorAll("[data-nav]").forEach((button) => {
      button.classList.toggle("active", button.dataset.nav === state.view);
      if (button.dataset.nav) button.setAttribute("aria-current", button.dataset.nav === state.view ? "page" : "false");
    });
    const pages = {
      overview: renderOverview,
      calls: renderCalls,
      attendance: renderAttendance,
      meetings: renderMeetings,
      directory: renderDirectory,
      "call-report": renderCallReport,
      "attendance-report": renderAttendanceReport,
      assistant: renderAssistant
    };
    content.innerHTML = pages[state.view]();
    updateCloudControls();
    if (storageFault) {
      content.insertAdjacentHTML("beforeend", '<div class="notice"><strong>Saved data could not be read.</strong> Changes are disabled to protect it. Use Restore backup to load a valid backup.</div>');
    }
  }

  function renderAssistant() {
    const welcome = {
      role: "assistant",
      text: "Ask in your own words, for example “Agnes,” “find calls for Acme,” “who worked remotely this week,” or “add attendance for Alice tomorrow.” Simple lookups run against records in this app. Complex requests go to Google Gemini, but saved records are not sent. New and edited records open for review before you save; deletions require confirmation.",
      actions: []
    };
    const messages = state.assistantMessages.length ? state.assistantMessages : [welcome];
    return `
      ${pageHeading("CALL & TIME APP ASSISTANT", "Assistant", "Ask about people, clients, calls, attendance, meetings, or app tasks.")}
      <section class="assistant-shell" aria-label="Call and Time assistant">
        <div class="assistant-status"><span class="assistant-status-dot"></span><span><strong>Call &amp; Time assistant</strong><small>Simple lookups use records in this app. Complex requests go to Google Gemini; saved records stay here.</small></span></div>
        <div class="assistant-thread" id="assistant-thread" role="log" aria-live="polite" aria-relevant="additions">
          ${messages.map(renderAssistantMessage).join("")}
        </div>
        <form class="assistant-composer" data-assistant-form>
          <label class="sr-only" for="assistant-query">Ask the assistant</label>
          <textarea id="assistant-query" name="query" rows="2" placeholder="Ask a question or describe a task…" maxlength="${ASSISTANT_MAX_PROMPT_LENGTH}" ${state.assistantBusy ? "disabled" : ""} required></textarea>
          <button class="btn btn-primary" type="submit" ${state.assistantBusy ? "disabled" : ""}>${state.assistantBusy ? "Thinking…" : "Ask assistant"}</button>
        </form>
        <div class="assistant-suggestions" aria-label="Suggested questions">
          <button class="assistant-suggestion" type="button" data-action="assistant-suggestion" data-query="Who is working remotely this week?">Remote staff this week</button>
          <button class="assistant-suggestion" type="button" data-action="assistant-suggestion" data-query="Show pending callbacks">Pending callbacks</button>
          <button class="assistant-suggestion" type="button" data-action="assistant-suggestion" data-query="Show upcoming meetings">Upcoming meetings</button>
          <button class="assistant-suggestion" type="button" data-action="assistant-suggestion" data-query="Add attendance">Prepare attendance</button>
        </div>
      </section>`;
  }

  function renderAssistantMessage(message) {
    const actions = (message.actions || []).map((action) => {
      if (action.type === "navigate") {
        return `<button class="btn btn-secondary btn-small" type="button" data-nav="${escapeHtml(action.view)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "new-record") {
        return `<button class="btn btn-secondary btn-small" type="button" data-action="assistant-new-record" data-kind="${escapeHtml(action.kind)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "edit-record") {
        return `<button class="btn btn-secondary btn-small" type="button" data-action="assistant-edit-record" data-kind="${escapeHtml(action.kind)}" data-id="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "assistant-person-choice") {
        return `<button class="btn btn-secondary btn-small" type="button" data-action="assistant-person-choice" data-kind="${escapeHtml(action.kind)}" data-id="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "delete-record") {
        return `<button class="btn btn-danger btn-small" type="button" data-action="assistant-delete-record" data-kind="${escapeHtml(action.kind)}" data-id="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "app-action") {
        return `<button class="btn btn-secondary btn-small" type="button" data-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>`;
      }
      if (action.type === "assistant-local-retry") {
        return `<button class="btn btn-secondary btn-small" type="button" data-action="assistant-local-retry" data-query="${escapeHtml(action.query)}">${escapeHtml(action.label)}</button>`;
      }
      return "";
    }).join("");
    return `<article class="assistant-message assistant-message-${message.role}">
      <div class="assistant-message-label">${message.role === "user" ? "You" : "Assistant"}</div>
      <div class="assistant-message-body">${escapeHtml(message.text).replace(/\n/g, "<br>")}</div>
      ${actions ? `<div class="assistant-message-actions">${actions}</div>` : ""}
    </article>`;
  }

  function assistantTypeFromText(query) {
    const text = query.toLowerCase();
    if (/\b(attendance|work mode|remote day|sick leave|public holiday)\b/.test(text)) return "attendance";
    if (/\b(meetings?|appointments?|calendar)\b/.test(text)) return "meeting";
    if (/\b(clients?|companies|contacts?)\b/.test(text)) return "client";
    if (/\b(staff|employees?|colleagues?)\b/.test(text)) return "staff";
    if (/\b(calls?|call log|callbacks?)\b/.test(text)) return "call";
    return "";
  }

  function assistantCollection(kind) {
    return ({ call: "calls", attendance: "attendance", meeting: "meetings", client: "clients", staff: "staff" })[kind] || "";
  }

  function assistantRecordFields(kind, record) {
    const fields = {
      call: ["client", "staff", "phone", "direction", "outcome", "followUp", "record", "notes", "date", "time"],
      attendance: ["staff", "status", "workMode", "location", "notes", "date"],
      meeting: ["subject", "organizer", "location", "category", "notes", "date", "startTime"],
      client: ["name", "phone", "alternatePhone", "email", "notes"],
      staff: ["name", "email"]
    }[kind] || [];
    return fields.map((fieldName) => record[fieldName] || "").join(" ");
  }

  function assistantTokens(text) {
    const ignored = new Set([
      "a", "about", "all", "an", "and", "are", "at", "by", "can", "details", "find", "for", "from",
      "give", "help", "how", "in", "information", "is", "it", "list", "look", "many", "me", "of", "on",
      "please", "records", "search", "show", "the", "this", "to", "up", "what", "where", "who", "with", "you"
    ]);
    return String(text).toLowerCase().split(/[^a-z0-9@.+-]+/)
      .filter((token) => token.length > 1 && !ignored.has(token));
  }

  function assistantRecordLabel(kind, record) {
    if (kind === "call") return `Call with ${record.client || "unknown client"} · ${formatDate(record.date)}${record.time ? ` at ${formatTime(record.time)}` : ""}`;
    if (kind === "attendance") return `Attendance · ${record.staff || "unknown staff"} · ${formatDate(record.date)}`;
    if (kind === "meeting") return `Meeting · ${record.subject || "untitled"} · ${formatDate(record.date)}${record.startTime ? ` at ${formatTime(record.startTime)}` : ""}`;
    return `${kind === "client" ? "Client" : "Staff"} · ${record.name || "unnamed"}${record.email ? ` · ${record.email}` : ""}`;
  }

  function assistantRecordDetail(kind, record) {
    if (kind === "call") return `${record.direction || "Call"} · ${record.outcome || "No outcome"} · ${record.staff || "No staff assigned"}${record.followUp && record.followUp !== "Not Required" ? ` · ${record.followUp}` : ""}`;
    if (kind === "attendance") return `${record.status || "No status"} · ${attendanceWorkMode(record)}${record.location ? ` · ${record.location}` : ""}`;
    if (kind === "meeting") return `${record.category || "Meeting"} · ${formatTime(record.startTime)}–${formatTime(record.endTime)}${record.location ? ` · ${record.location}` : ""}`;
    return [record.phone, record.email, record.notes].filter(Boolean).join(" · ") || "No additional details saved";
  }

  function assistantSearchTokens(query) {
    return assistantTokens(query).filter((token) => ![
      "call", "calls", "attendance", "meeting", "meetings", "appointment", "appointments",
      "client", "clients", "staff", "employee", "employees", "contact", "contacts",
      "change", "complete", "create", "delete", "edit", "enter", "entries", "entry", "fill",
      "add", "new", "remove", "record", "update"
    ].includes(token));
  }

  function assistantFindRecords(query, kind, includeUnfiltered = false) {
    const kinds = kind ? [kind] : ["call", "attendance", "meeting", "client", "staff"];
    const tokens = assistantSearchTokens(query);
    const matches = [];
    kinds.forEach((recordKind) => {
      const collection = assistantCollection(recordKind);
      state.data[collection].forEach((record) => {
        const haystack = assistantRecordFields(recordKind, record).toLowerCase();
        const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
        if (score > 0 || (includeUnfiltered && tokens.length === 0)) matches.push({ kind: recordKind, record, score });
      });
    });
    return matches.sort((a, b) => b.score - a.score ||
      `${b.record.date || ""} ${b.record.time || b.record.startTime || ""}`.localeCompare(`${a.record.date || ""} ${a.record.time || a.record.startTime || ""}`));
  }

  function assistantPersonMatches(query) {
    const contextWords = new Set([
      "about", "all", "are", "attendance", "call", "calls", "client", "clients", "colleague", "colleagues",
      "company", "companies", "contact", "contacts", "current", "data", "details", "did", "do", "does",
      "employee", "employees", "find", "for", "from", "had", "have", "help", "history", "how", "information",
      "is", "last", "list", "look", "me", "meeting", "meetings", "monday", "name", "next", "of", "on", "open", "people",
      "person", "please", "record", "records", "remote", "remotely", "report", "search", "show", "staff", "tell",
      "this", "today", "tuesday", "upcoming", "wednesday", "thursday", "friday", "saturday", "sunday", "week",
      "where", "who", "with", "work", "worked", "working", "would", "you"
    ]);
    const queryTokens = assistantTokens(query).filter((token) => !contextWords.has(token));
    if (!queryTokens.length) return [];

    const people = [
      ...state.data.staff.map((record) => ({ kind: "staff", record })),
      ...state.data.clients.map((record) => ({ kind: "client", record }))
    ];
    return people.filter(({ record }) => {
      const nameTokens = assistantTokens(record.name || "");
      return queryTokens.every((queryToken) => nameTokens.some((nameToken) =>
        nameToken === queryToken || (queryToken.length >= 3 && nameToken.startsWith(queryToken))));
    }).sort((a, b) => String(a.record.name || "").localeCompare(String(b.record.name || "")) || a.kind.localeCompare(b.kind));
  }

  function assistantPersonChoiceLabel(person) {
    const distinction = person.record.email || person.record.phone || person.record.alternatePhone || "";
    const role = person.kind === "staff" ? "Staff" : "Client";
    return `${role} · ${person.record.name || "Unnamed"}${distinction ? ` · ${distinction}` : ""}`;
  }

  function assistantPersonRecords(person) {
    const name = String(person.record.name || "").trim().toLocaleLowerCase();
    const records = [{ kind: person.kind, record: person.record }];
    if (!name) return records;

    if (person.kind === "staff") {
      records.push(
        ...state.data.calls.filter((record) => String(record.staff || "").trim().toLocaleLowerCase() === name)
          .map((record) => ({ kind: "call", record })),
        ...state.data.attendance.filter((record) => String(record.staff || "").trim().toLocaleLowerCase() === name)
          .map((record) => ({ kind: "attendance", record })),
        ...state.data.meetings.filter((record) => String(record.organizer || "").trim().toLocaleLowerCase() === name)
          .map((record) => ({ kind: "meeting", record }))
      );
    } else {
      records.push(
        ...state.data.calls.filter((record) => String(record.client || "").trim().toLocaleLowerCase() === name)
          .map((record) => ({ kind: "call", record }))
      );
    }
    return records;
  }

  function assistantPersonAnswer(query, person) {
    const related = assistantPersonRecords(person);
    const profile = related[0];
    const activity = related.slice(1);
    const visibleActivity = activity.slice(0, 8);
    const details = [
      `${assistantRecordLabel(profile.kind, profile.record)}\n  ${assistantRecordDetail(profile.kind, profile.record)}`,
      ...visibleActivity.map(({ kind, record }) => `${assistantRecordLabel(kind, record)}\n  ${assistantRecordDetail(kind, record)}`)
    ].join("\n");
    const activityNote = activity.length > visibleActivity.length
      ? `\nShowing ${visibleActivity.length} of ${activity.length} related records.`
      : activity.length ? "" : "\nNo related calls, attendance, or meetings are saved for this contact.";
    const views = [...new Set(["directory", ...activity.map(({ kind }) =>
      kind === "call" ? "calls" : kind === "attendance" ? "attendance" : "meetings"
    )])];
    return {
      text: `I matched “${query}” to ${assistantPersonChoiceLabel(person)}.\n${details}${activityNote}`,
      actions: views.map((view) => ({ type: "navigate", view, label: `Open ${sectionTitles[view]}` }))
    };
  }

  function assistantCanHandleLocally(query) {
    const lower = query.toLowerCase();
    if (/\b(add|complete|create|enter|fill|log|record|schedule|make|edit|update|change|delete|remove)\b/.test(lower)) {
      return false;
    }
    if (assistantPersonMatches(query).length) return true;
    if (/^(help|what can you do|how do i use you)\??$/.test(lower.trim())) return true;
    if (/\b(download|export)\b/.test(lower) && /\b(backup|json|attendance|pdf|report|calls?|csv)\b/.test(lower)) return true;
    if (/\b(open|go to|take me to|navigate to|show tab)\b/.test(lower) && assistantNavigateTarget(query)) return true;
    if (/\b(remote(?:ly)?|work from home|home working)\b/.test(lower) && /\b(who|staff|people|remote|remotely|working|worked|home)\b/.test(lower)) return true;
    if (/\b(pending callbacks?|open callbacks?|follow[- ]?ups?)\b/.test(lower)) return true;
    if (/\b(upcoming|next)\b/.test(lower) && /\b(meetings?|appointments?)\b/.test(lower)) return true;
    if (/\b(weekly|this|current|last)\b/.test(lower) && /\b(attendance|hours|remote|staff|calls?|call log)\b/.test(lower)) return true;

    const readIntent = /\b(find|search|show|list|who|what|where|when|which|how many|tell me about)\b/.test(lower);
    const complexIntent = /\b(analy[sz]e|compare|recommend|suggest|advise|advice|explain|prioriti[sz]e|should|why)\b/.test(lower);
    return readIntent && !complexIntent && assistantSearchTokens(query).length > 0;
  }

  function assistantNavigateTarget(query) {
    const text = query.toLowerCase();
    const targets = [
      ["attendance-report", /\b(weekly attendance|attendance report)\b/],
      ["call-report", /\b(weekly calls|calls report|call report)\b/],
      ["attendance", /\b(attendance|work mode|remote days?)\b/],
      ["meetings", /\b(meetings?|appointments?|calendar)\b/],
      ["directory", /\b(directory|contacts?|clients?|staff|employees?)\b/],
      ["calls", /\b(call log|calls?)\b/],
      ["overview", /\b(overview|dashboard|home)\b/]
    ];
    return targets.find(([, pattern]) => pattern.test(text))?.[0] || "";
  }

  function assistantActionForRecord(kind, record, actionType) {
    return { type: actionType, kind, id: record.id, label: actionType === "delete-record" ? `Delete ${assistantRecordLabel(kind, record)}` : `Review ${assistantRecordLabel(kind, record)}` };
  }

  function assistantWeekStart(query) {
    const thisMonday = mondayOf(today);
    return /\blast week\b/.test(query.toLowerCase()) ? addDays(thisMonday, -7) : thisMonday;
  }

  function assistantDateRange(query) {
    const lower = query.toLowerCase();
    if (/\btoday\b/.test(lower)) return [today, today];
    if (/\byesterday\b/.test(lower)) {
      const yesterday = addDays(today, -1);
      return [yesterday, yesterday];
    }

    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const namedDay = lower.match(/\b(this|last|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (namedDay) {
      const weekOffset = namedDay[1] === "last" ? -7 : namedDay[1] === "next" ? 7 : 0;
      const weekStart = addDays(mondayOf(today), weekOffset);
      const weekdayIndex = weekdays.indexOf(namedDay[2]);
      const date = addDays(weekStart, weekdayIndex === 0 ? 6 : weekdayIndex - 1);
      return [date, date];
    }

    const weekStart = assistantWeekStart(query);
    return [weekStart, addDays(weekStart, 4)];
  }

  function assistantAnswer(query) {
    const text = query.trim();
    const lower = text.toLowerCase();
    const type = assistantTypeFromText(text);
    const answer = (message, actions = [], execute = null) => ({ text: message, actions, execute });
    const createIntent = /\b(add|complete|create|enter|fill|log|record|schedule|make)\b/.test(lower) || /\bnew\s+(call|attendance|meeting|appointment|client|staff)\b/.test(lower);
    const personMatches = assistantPersonMatches(text);

    if (/^(help|what can you do|how do i use you)\??$/.test(lower.trim())) {
      return answer("Type a command and press Enter. Examples: “find calls for Acme,” “open attendance,” “add attendance,” “edit call for Acme,” “delete client Acme,” or “summarize attendance this week.” I run supported app commands directly; new and edited records open for your review, and deletions require confirmation.");
    }

    if (createIntent && type) {
      return answer(`Opening a new ${type} form. Review the details and choose Save yourself.`, [], { type: "new-record", kind: type });
    }
    if (createIntent && !type) {
      return answer("Which kind of entry do you mean? Choose a form, then review the details and save it yourself.", [
        { type: "new-record", kind: "call", label: "Call" },
        { type: "new-record", kind: "attendance", label: "Attendance" },
        { type: "new-record", kind: "meeting", label: "Meeting" },
        { type: "new-record", kind: "client", label: "Client" },
        { type: "new-record", kind: "staff", label: "Staff" }
      ]);
    }

    const editIntent = /\b(edit|update|change)\b/.test(lower);
    const deleteIntent = /\b(delete|remove)\b/.test(lower);
    if ((editIntent || deleteIntent) && type) {
      if ((type === "client" || type === "staff") && editIntent) {
        return answer("The directory currently does not have an edit form. Open Directory to review the contact; adding or deleting contacts remains available there.", [{ type: "navigate", view: "directory", label: "Open Directory" }]);
      }
      const matches = assistantFindRecords(text, type, true).slice(0, 5);
      if (!matches.length) return answer(`I couldn't find a matching ${type}. Try including a name, client, or date.`);
      const specificMatch = assistantSearchTokens(text).length > 0;
      if (specificMatch && matches.length === 1) {
        const command = assistantActionForRecord(type, matches[0].record, deleteIntent ? "delete-record" : "edit-record");
        return answer(deleteIntent
          ? `I found one matching ${type}. Confirm the delete prompt if you want to remove it.`
          : `Opening the matching ${type} for review. Save any changes yourself.`, [], command);
      }
      const actions = matches.map(({ kind, record }) => assistantActionForRecord(kind, record, deleteIntent ? "delete-record" : "edit-record"));
      return answer(deleteIntent
        ? `Review the matching ${type} below. Nothing will be deleted unless you select a record and confirm the browser's delete prompt.`
        : `Choose the ${type} to open its existing form. Review any changes and choose Save yourself.`, actions);
    }

    if (personMatches.length > 1) {
      const labels = personMatches.map(assistantPersonChoiceLabel);
      const labelCounts = new Map(labels.map((label) => [label, labels.filter((item) => item === label).length]));
      return answer(`I found ${personMatches.length} matching staff/client records. Choose the person or client you mean:`,
        personMatches.map((person, index) => ({
          type: "assistant-person-choice",
          kind: person.kind,
          id: person.record.id,
          label: `${labels[index]}${labelCounts.get(labels[index]) > 1 ? ` · record ${index + 1}` : ""}`
        })));
    }

    if (/\b(download|export)\b/.test(lower) && /\b(backup|json)\b/.test(lower)) {
      return answer("Exporting a backup of the records saved in this browser.", [], { type: "app-action", action: "backup" });
    }
    if (/\b(download|export)\b/.test(lower) && /\b(attendance|pdf|report)\b/.test(lower)) {
      return answer("Opening the attendance report in the print dialog. Choose Print or Save as PDF there.", [], { type: "app-action", action: "download-attendance-report" });
    }
    if (/\b(download|export)\b/.test(lower) && /\b(calls?|csv)\b/.test(lower)) {
      return answer("Exporting calls for the currently selected report week.", [], { type: "app-action", action: "export-csv" });
    }

    if (/\b(open|go to|take me to|navigate to|show tab)\b/.test(lower)) {
      const view = assistantNavigateTarget(text);
      if (view) return answer(`Opening ${sectionTitles[view]}.`, [], { type: "navigate", view });
    }

    const weekStart = assistantWeekStart(text);
    const weekEnd = addDays(weekStart, 4);
    const [rangeStart, rangeEnd] = assistantDateRange(text);
    if (/\b(remote(?:ly)?|work from home|home working)\b/.test(lower) && /\b(who|staff|people|remote|remotely|working|home)\b/.test(lower)) {
      const remote = state.data.attendance.filter((entry) => entry.date >= rangeStart && entry.date <= rangeEnd &&
        attendanceDayKind(entry) === "present" && /remote|home/i.test(entry.workMode || ""));
      const contextWords = new Set(["days", "friday", "home", "last", "monday", "next", "people", "remote", "remotely", "saturday", "staff", "sunday", "this", "thursday", "tuesday", "wednesday", "week", "working", "worked", "who"]);
      const personTokens = assistantTokens(text).filter((token) => !contextWords.has(token));
      const selectedRemote = personMatches.length === 1 && personMatches[0].kind === "staff"
        ? remote.filter((entry) => String(entry.staff || "").trim().toLocaleLowerCase() === String(personMatches[0].record.name || "").trim().toLocaleLowerCase())
        : personMatches.length === 1
          ? []
          : personTokens.length
            ? remote.filter((entry) => personTokens.some((token) => (entry.staff || "").toLowerCase().includes(token)))
            : remote;
      const byStaff = [...new Set(selectedRemote.map((entry) => entry.staff).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const period = rangeStart === rangeEnd ? formatDate(rangeStart) : `${formatDate(rangeStart)}–${formatDate(rangeEnd)}`;
      const names = byStaff.length ? byStaff.join(", ") : "No remote attendance entries found";
      return answer(`Remote staff for ${period}: ${names}.`, [{ type: "navigate", view: "attendance", label: "Open attendance" }]);
    }

    if (/\b(pending callbacks?|open callbacks?|follow[- ]?ups?)\b/.test(lower)) {
      const callbacks = sortedByNewest(state.data.calls.filter((call) => isOpenCallback(call) &&
        (!personMatches.length || String(personMatches[0].kind === "staff" ? call.staff : call.client || "")
          .trim().toLocaleLowerCase() === String(personMatches[0].record.name || "").trim().toLocaleLowerCase()))).slice(0, 8);
      const details = callbacks.length
        ? callbacks.map((call) => `• ${assistantRecordLabel("call", call)} · ${call.followUp || "Pending"}`).join("\n")
        : "There are no pending callbacks.";
      return answer(details, [{ type: "navigate", view: "calls", label: "Open call log" }]);
    }

    if (/\b(upcoming|next)\b/.test(lower) && /\b(meetings?|appointments?)\b/.test(lower)) {
      const meetings = sortedByNewest(state.data.meetings.filter((meeting) => meeting.date >= today &&
        (!personMatches.length || (personMatches[0].kind === "staff"
          ? String(meeting.organizer || "").trim().toLocaleLowerCase() === String(personMatches[0].record.name || "").trim().toLocaleLowerCase()
          : String(meeting.subject || "").toLocaleLowerCase().includes(String(personMatches[0].record.name || "").toLocaleLowerCase())))),
      "date", "startTime").slice(0, 8);
      const details = meetings.length
        ? meetings.map((meeting) => `• ${assistantRecordLabel("meeting", meeting)} · ${meeting.location || "No location"}`).join("\n")
        : "There are no upcoming meetings saved.";
      return answer(details, [{ type: "navigate", view: "meetings", label: "Open meetings" }]);
    }

    if (/\b(weekly|this|current|last)\b/.test(lower) && /\b(attendance|hours|remote|staff)\b/.test(lower)) {
      const rows = weeklyAttendanceSummary(currentWeekAttendance(weekStart))
        .filter((row) => (!personMatches.length || (personMatches[0].kind === "staff" &&
          row.name.trim().toLocaleLowerCase() === String(personMatches[0].record.name || "").trim().toLocaleLowerCase())) &&
          (row.presentDays || row.leaveDays || row.sickDays || row.publicHolidayDays));
      const details = rows.length
        ? rows.map((row) => `• ${row.name}: ${formatHours(row.totalHours)} total · ${row.presentDays} present · ${row.remoteDays} remote${row.leaveDays ? ` · ${row.leaveDays} leave` : ""}${row.sickDays ? ` · ${row.sickDays} sick` : ""}${row.publicHolidayDays ? ` · ${row.publicHolidayDays} public holiday` : ""}`).join("\n")
        : "No attendance entries were found for that workweek.";
      return answer(`Weekly attendance (${formatDate(weekStart)}–${formatDate(weekEnd)}):\n${details}`, [{ type: "navigate", view: "attendance-report", label: "Open weekly attendance" }]);
    }

    if (/\b(weekly|this|current|last)\b/.test(lower) && /\b(calls?|call log)\b/.test(lower)) {
      const calls = currentWeekCalls(weekStart).filter((call) => !personMatches.length ||
        String(personMatches[0].kind === "staff" ? call.staff : call.client || "").trim().toLocaleLowerCase() ===
        String(personMatches[0].record.name || "").trim().toLocaleLowerCase());
      const pending = calls.filter(isOpenCallback).length;
      return answer(`There are ${calls.length} calls for ${formatDate(weekStart)}–${formatDate(weekEnd)}, including ${pending} pending callbacks.`, [{ type: "navigate", view: "call-report", label: "Open weekly calls" }]);
    }

    if (personMatches.length === 1) return assistantPersonAnswer(text, personMatches[0]);

    const searchTokens = assistantSearchTokens(text);
    const listIntent = /\b(list|show|find|search|who|what)\b/.test(lower);
    if (!searchTokens.length && !(type && listIntent)) {
      return answer("I’m not sure what information or task you mean. Tell me the record type and a name, date, or action. For example: “find calls for Acme” or “add attendance.”");
    }
    const matches = assistantFindRecords(text, type, Boolean(type && listIntent && !searchTokens.length)).slice(0, 8);
    if (!matches.length) {
      return answer("I couldn't find matching saved information. Try a person's name, client, meeting subject, or a more specific date. Say “help” to see examples.");
    }
    const details = matches.map(({ kind, record }) => `• ${assistantRecordLabel(kind, record)}\n  ${assistantRecordDetail(kind, record)}`).join("\n");
    const views = [...new Set(matches.map(({ kind }) => kind === "call" ? "calls" : kind === "attendance" ? "attendance" : kind === "meeting" ? "meetings" : "directory"))];
    return answer(`Found ${matches.length} matching record${matches.length === 1 ? "" : "s"}:\n${details}`,
      views.map((view) => ({ type: "navigate", view, label: `Open ${sectionTitles[view]}` })));
  }

  function assistantResponse(value) {
    const actions = new Set(["reply", "search", "navigate", "create", "edit", "delete", "summary", "export"]);
    const kinds = new Set(["call", "attendance", "meeting", "client", "staff", "none"]);
    const views = new Set(["overview", "calls", "attendance", "meetings", "directory", "call-report", "attendance-report"]);
    const periods = new Set(["today", "this-week", "last-week", "none"]);
    const exports = new Set(["calls-csv", "attendance-pdf", "backup", "none"]);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Gemini returned an invalid response. Please try again.");
    }
    return {
      reply: typeof value.reply === "string" ? value.reply.slice(0, 2000) : "",
      action: actions.has(value.action) ? value.action : "reply",
      kind: kinds.has(value.kind) ? value.kind : "none",
      view: views.has(value.view) ? value.view : "overview",
      period: periods.has(value.period) ? value.period : "none",
      exportType: exports.has(value.exportType) ? value.exportType : "none",
      query: typeof value.query === "string" ? value.query.slice(0, 300) : "",
      draft: value.draft && typeof value.draft === "object" && !Array.isArray(value.draft) ? value.draft : {}
    };
  }

  function assistantSummary(kind, period) {
    const start = period === "today" ? today : addDays(mondayOf(today), period === "last-week" ? -7 : 0);
    const end = period === "today" ? today : addDays(start, 4);
    const label = period === "today" ? formatDate(today) : `${formatDate(start)}–${formatDate(end)}`;
    if (kind === "attendance") {
      const entries = state.data.attendance.filter((entry) => entry.date >= start && entry.date <= end);
      if (period === "today") {
        const details = entries.length
          ? entries.map((entry) => `• ${entry.staff || "Unnamed staff"}: ${entry.status || "No status"} · ${attendanceWorkMode(entry)}`).join("\n")
          : "No attendance entries were found.";
        return `Attendance for ${label}:\n${details}`;
      }
      const rows = weeklyAttendanceSummary(entries)
        .filter((row) => row.presentDays || row.leaveDays || row.sickDays || row.publicHolidayDays);
      const details = rows.length
        ? rows.map((row) => `• ${row.name}: ${formatHours(row.totalHours)} hours · ${row.presentDays} present · ${row.remoteDays} remote${row.leaveDays ? ` · ${row.leaveDays} leave` : ""}${row.sickDays ? ` · ${row.sickDays} sick` : ""}${row.publicHolidayDays ? ` · ${row.publicHolidayDays} public holiday` : ""}`).join("\n")
        : "No attendance entries were found.";
      return `Weekly attendance (${label}):\n${details}`;
    }
    if (kind === "call") {
      const calls = state.data.calls.filter((call) => call.date >= start && call.date <= end);
      const pending = calls.filter(isOpenCallback).length;
      return `Calls for ${label}: ${calls.length} total — ${calls.filter((call) => call.direction === "Incoming").length} incoming, ${calls.filter((call) => call.direction === "Outgoing").length} outgoing, ${pending} pending callbacks.`;
    }
    return "I can summarize calls or attendance. Which one would you like?";
  }

  function assistantDraft(kind, draft) {
    const source = draft && typeof draft === "object" ? draft : {};
    const result = {};
    const textFields = {
      call: ["client", "phone", "staff", "record", "notes"],
      attendance: ["staff", "location", "notes"],
      meeting: ["subject", "location", "organizer", "notes"],
      client: ["name", "phone", "alternatePhone", "email", "notes"],
      staff: ["name", "email"]
    }[kind] || [];
    textFields.forEach((key) => {
      if (typeof source[key] === "string") result[key] = source[key].trim().slice(0, key === "notes" || key === "record" ? 1000 : 200);
    });
    const enumFields = {
      call: { direction: ["Incoming", "Outgoing"], outcome: ["Succeeded", "Engaged", "Callback Requested", "No Answer", "Unavailable", "Unreachable", "Voicemail", "Other"], followUp: ["Not Required", "Callback Pending", "In Progress", "Completed", "Callback Completed"] },
      attendance: { status: ["Present", "Partial", "Leave", "Sick Leave", "Absent"], workMode: ["Office", "Client Direct", "Office -> Client", "Remote", "Other", "Public Holiday"] },
      meeting: { category: ["Meeting", "Appointment", "Training", "Internal", "Client", "Other"] }
    }[kind] || {};
    Object.entries(enumFields).forEach(([key, choices]) => {
      if (choices.includes(source[key])) result[key] = source[key];
    });
    ["date", "time", "startTime", "endTime"].forEach((key) => {
      if (typeof source[key] !== "string") return;
      if (/^\d{4}-\d{2}-\d{2}$/.test(source[key])) {
        const parsedDate = new Date(`${source[key]}T00:00:00Z`);
        if (Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === source[key]) result[key] = source[key];
      } else if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(source[key])) result[key] = source[key];
    });
    if (kind === "attendance" && typeof source.expectedHours === "number" && Number.isFinite(source.expectedHours) && source.expectedHours >= 0 && source.expectedHours <= 24) {
      result.expectedHours = Number(source.expectedHours);
    }
    return result;
  }

  function runLocalAssistant(query) {
    const response = assistantAnswer(query);
    state.assistantMessages.push({ role: "assistant", text: response.text, actions: response.actions });
    if (state.assistantMessages.length > 40) state.assistantMessages.splice(0, state.assistantMessages.length - 40);
    render();
    if (response.execute) executeAssistantAction(response.execute);
    document.querySelector("#assistant-thread")?.scrollTo(0, document.querySelector("#assistant-thread").scrollHeight);
    document.querySelector("#assistant-query")?.focus();
  }

  function chooseAssistantPerson(kind, recordId) {
    const collection = assistantCollection(kind);
    const record = collection && state.data[collection].find((item) => item.id === recordId);
    if (!record) {
      toast("That contact is no longer available. Try the name again.");
      return;
    }
    const response = assistantPersonAnswer(record.name, { kind, record });
    state.assistantMessages.push({ role: "assistant", text: response.text, actions: response.actions });
    if (state.assistantMessages.length > 40) state.assistantMessages.splice(0, state.assistantMessages.length - 40);
    render();
  }

  async function handleGeminiAction(result, prompt, responseIndex) {
    const setReply = (text, actions = []) => {
      state.assistantMessages[responseIndex] = { role: "assistant", text, actions };
      render();
    };
    if (result.action === "navigate") {
      setReply(`Opening ${sectionTitles[result.view]}.`);
      executeAssistantAction({ type: "navigate", view: result.view });
      return;
    }
    if (result.action === "create" && result.kind !== "none") {
      setReply(`I prepared a draft for ${result.kind}. Review the details and choose Save yourself.`);
      executeAssistantAction({ type: "new-record", kind: result.kind, draft: assistantDraft(result.kind, result.draft) });
      return;
    }
    if ((result.action === "edit" || result.action === "delete") && result.kind !== "none") {
      const local = assistantAnswer(`${result.action} ${result.kind} ${result.query || prompt}`);
      setReply(local.text, local.actions);
      if (local.execute) executeAssistantAction(local.execute);
      return;
    }
    if (result.action === "search") {
      const search = result.query || prompt;
      const matches = assistantFindRecords(search, result.kind === "none" ? "" : result.kind).slice(0, 8);
      if (!matches.length) {
        setReply("I couldn't find matching saved information. Your records stay in Call & Time and are not shared with Gemini.");
        return;
      }
      const details = matches.map(({ kind, record }) => `• ${assistantRecordLabel(kind, record)}\n  ${assistantRecordDetail(kind, record)}`).join("\n");
      const views = [...new Set(matches.map(({ kind }) => kind === "call" ? "calls" : kind === "attendance" ? "attendance" : kind === "meeting" ? "meetings" : "directory"))];
      setReply(`Found ${matches.length} matching record${matches.length === 1 ? "" : "s"}:\n${details}`,
        views.map((view) => ({ type: "navigate", view, label: `Open ${sectionTitles[view]}` })));
      return;
    }
    if (result.action === "summary" && (result.kind === "attendance" || result.kind === "call")) {
      if (result.period !== "today") {
        state.reportStart = addDays(mondayOf(today), result.period === "last-week" ? -7 : 0);
      }
      const reportView = result.period === "today"
        ? (result.kind === "attendance" ? "attendance" : "calls")
        : (result.kind === "attendance" ? "attendance-report" : "call-report");
      setReply(assistantSummary(result.kind, result.period === "none" ? "this-week" : result.period), [{
        type: "navigate",
        view: reportView,
        label: result.period === "today"
          ? (result.kind === "attendance" ? "Open attendance" : "Open call log")
          : (result.kind === "attendance" ? "Open weekly attendance" : "Open weekly calls")
      }]);
      return;
    }
    if (result.action === "export" && result.exportType !== "none") {
      const exportActions = {
        "calls-csv": { type: "app-action", action: "export-csv" },
        "attendance-pdf": { type: "app-action", action: "download-attendance-report" },
        backup: { type: "app-action", action: "backup" }
      };
      const action = exportActions[result.exportType];
      setReply("Starting the requested export.");
      executeAssistantAction(action);
      return;
    }
    setReply(result.reply || "I can help search records, summarize calls or attendance, navigate sections, prepare forms, and export reports.");
  }

  async function submitAssistantQuery(query) {
    const trimmed = query.trim();
    if (!trimmed || state.assistantBusy) return;
    if (trimmed.length > ASSISTANT_MAX_PROMPT_LENGTH) {
      toast(`Keep assistant messages under ${ASSISTANT_MAX_PROMPT_LENGTH} characters.`);
      return;
    }
    state.assistantMessages.push({ role: "user", text: trimmed });
    state.view = "assistant";
    if (assistantCanHandleLocally(trimmed)) {
      runLocalAssistant(trimmed);
      return;
    }
    state.assistantMessages.push({ role: "assistant", text: "Thinking with Gemini…", actions: [] });
    if (state.assistantMessages.length > 40) state.assistantMessages.splice(0, state.assistantMessages.length - 40);
    const adjustedResponseIndex = state.assistantMessages.length - 1;
    state.assistantBusy = true;
    state.view = "assistant";
    render();
    try {
      const response = await cloudRequest(ASSISTANT_FUNCTION_PATH, {
        method: "POST",
        body: JSON.stringify({ prompt: trimmed, localDate: today })
      });
      await handleGeminiAction(assistantResponse(response), trimmed, adjustedResponseIndex);
    } catch (error) {
      console.error("Gemini assistant request failed.", error);
      state.assistantMessages[adjustedResponseIndex] = {
        role: "assistant",
        text: `I couldn't reach Gemini: ${error.message}`,
        actions: [{ type: "assistant-local-retry", query: trimmed, label: "Try local command helper" }]
      };
    } finally {
      state.assistantBusy = false;
      if (state.view === "assistant") {
        render();
        document.querySelector("#assistant-thread")?.scrollTo(0, document.querySelector("#assistant-thread").scrollHeight);
        document.querySelector("#assistant-query")?.focus();
      }
    }
  }

  function executeAssistantAction(action) {
    if (action.type === "navigate") {
      state.view = action.view;
      render();
      content.focus();
    } else if (action.type === "new-record") {
      if (storageFault) {
        toast("Changes are disabled until you restore a valid backup.");
      } else if (action.kind === "call") showCallForm("", action.draft);
      else if (action.kind === "attendance") showAttendanceForm("", action.draft);
      else if (action.kind === "meeting") showMeetingForm("", action.draft);
      else if (action.kind === "client" || action.kind === "staff") showDirectoryForm(action.kind, action.draft);
    } else if (action.type === "edit-record") {
      if (action.kind === "call") showCallForm(action.id);
      else if (action.kind === "attendance") showAttendanceForm(action.id);
      else if (action.kind === "meeting") showMeetingForm(action.id);
    } else if (action.type === "delete-record") {
      const name = action.kind === "attendance" ? "attendance entry" : action.kind;
      deleteAction(assistantCollection(action.kind), action.id, name);
    } else if (action.type === "app-action" && action.action === "backup") {
      exportBackup();
    } else if (action.type === "app-action" && action.action === "export-csv") {
      exportCallsCsv();
    } else if (action.type === "app-action" && action.action === "download-attendance-report") {
      state.view = "attendance-report";
      render();
      downloadAttendanceReport();
    } else if (action.type === "assistant-local-retry") {
      runLocalAssistant(action.query);
    }
  }

  function renderOverview() {
    const selectedDay = state.overviewDay || today;
    const selectedCalls = state.data.calls.filter((call) => call.date === selectedDay);
    const followUps = pendingCallbackThreads(state.data.calls);
    const selectedAttendance = state.data.attendance.filter((entry) => entry.date === selectedDay);
    const selectedMeetings = state.data.meetings.filter((meeting) => meeting.date === selectedDay).sort((a, b) => a.startTime.localeCompare(b.startTime));
    const selectedDateLabel = formatDate(selectedDay, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const recent = sortedByNewest(selectedCalls).slice(0, 5);
    const greeting = new Intl.DateTimeFormat("en-KE", { weekday: "long" }).format(dateFromInput(selectedDay));
    return `
      ${pageHeading("YOUR WORKSPACE", `Good ${greeting}`, `A clear view of calls, attendance, and appointments for ${selectedDateLabel}.`, `<div class="overview-controls"><label class="overview-date-label" for="overview-day">View date</label><input class="overview-date" id="overview-day" type="date" value="${escapeHtml(selectedDay)}" aria-label="Choose overview date"><button class="btn btn-primary" type="button" data-action="new-call"><span>＋</span> Log a call</button></div>`)}
      <section class="stats-grid">
        ${statCard("Calls on date", selectedCalls.length, `${selectedCalls.filter((call) => call.direction === "Incoming").length} incoming · ${selectedCalls.filter((call) => call.direction === "Outgoing").length} outgoing`, "↗")}
        ${statCard("Follow-ups due", followUps.length, "Across all logged calls", "↻")}
        ${statCard("Attendance logged", selectedAttendance.length, `${selectedAttendance.filter((entry) => /present|partial/i.test(entry.status)).length} marked present or partial`, "◷")}
        ${statCard("Meetings on date", selectedMeetings.length, selectedMeetings.length ? `Next: ${formatTime(selectedMeetings[0].startTime)}` : "No meetings scheduled", "▦")}
      </section>
      <section class="dashboard-grid">
        <article class="panel">
          <header class="panel-header"><div><h2>Calls for selected date</h2><p>Incoming and outgoing activity on ${selectedDateLabel}</p></div><button class="text-button" type="button" data-nav="calls">View call log →</button></header>
          ${recent.length ? `<div class="activity-list">${recent.map((call) => `
            <div class="activity-item"><span class="activity-mark">${call.direction === "Incoming" ? "↙" : "↗"}</span><div class="activity-copy"><div class="activity-title">${escapeHtml(call.client)}</div><div class="activity-meta">${escapeHtml(call.direction)} · ${escapeHtml(call.staff || "No staff selected")} · ${escapeHtml(call.outcome)}</div></div><span class="activity-time">${formatDate(call.date, { day: "numeric", month: "short" })} · ${formatTime(call.time)}</span></div>`).join("")}</div>` : emptyState("No calls logged for this date", "Choose another date or record a call for this day.")}
        </article>
        <article class="panel">
          <header class="panel-header"><div><h2>Follow-up queue</h2><p>Callbacks and actions to complete</p></div><span class="badge badge-amber">${followUps.length} open</span></header>
          ${followUps.length ? `<div class="queue-list">${sortedByNewest(followUps).slice(0, 5).map((call) => `<div class="queue-item"><div><div class="queue-title">${escapeHtml(call.client)}</div><div class="queue-meta">${escapeHtml(call.staff || "Unassigned")} · ${formatDate(call.date)}</div></div>${badge(call.followUp)}</div>`).join("")}</div>` : emptyState("You're all caught up", "Calls marked for follow-up will appear here.")}
        </article>
      </section>
      <section class="panel section-spacer">
        <header class="panel-header"><div><h2>Schedule for selected date</h2><p>Appointments you've added for ${selectedDateLabel}</p></div><button class="text-button" type="button" data-nav="meetings">Manage meetings →</button></header>
        ${selectedMeetings.length ? `<div class="queue-list">${selectedMeetings.map((meeting) => `<div class="queue-item"><div><div class="queue-title">${escapeHtml(meeting.subject)}</div><div class="queue-meta">${formatTime(meeting.startTime)} – ${formatTime(meeting.endTime)} · ${escapeHtml(meeting.location || "No location")}</div></div><span class="badge">${escapeHtml(meeting.organizer || "No organizer")}</span></div>`).join("")}</div>` : emptyState("Nothing scheduled", "Add a meeting or appointment to your schedule.")}
      </section>`;
  }

  function callRows(calls) {
    if (!calls.length) return `<tr><td class="table-empty" colspan="7">No call records match your search.</td></tr>`;
    return calls.map((call) => `<tr>
      <td><div class="table-primary">${formatDate(call.date)}</div><div class="table-secondary">${formatTime(call.time)}</div></td>
      <td><div class="table-primary">${escapeHtml(call.client)}</div><div class="table-secondary">${escapeHtml(call.phone || "No number")}</div></td>
      <td>${badge(call.direction)}</td>
      <td><div class="table-primary">${escapeHtml(call.staff || "—")}</div><div class="table-secondary">${escapeHtml(call.outcome)}</div></td>
      <td>${badge(call.followUp || "Not required")}</td>
      <td>${escapeHtml(call.notes || call.record || "—")}</td>
      <td><div class="table-actions"><button class="icon-button" type="button" aria-label="Edit call" title="Edit" data-action="edit-call" data-id="${escapeHtml(call.id)}">✎</button><button class="icon-button" type="button" aria-label="Delete call" title="Delete" data-action="delete-call" data-id="${escapeHtml(call.id)}">×</button></div></td>
    </tr>`).join("");
  }

  function renderCalls() {
    const filtered = sortedByNewest(state.data.calls).filter((call) => {
      const matchesDirection = state.callFilter === "all" || call.direction.toLowerCase() === state.callFilter;
      const search = state.callSearch.trim().toLowerCase();
      const matchesSearch = !search || [call.client, call.phone, call.staff, call.outcome, call.notes, call.record].some((value) => String(value || "").toLowerCase().includes(search));
      return matchesDirection && matchesSearch;
    });
    return `
      ${pageHeading("CALL REGISTER", "Call log", "Record incoming enquiries and outgoing client calls.", `<button class="btn btn-primary" type="button" data-action="new-call"><span>＋</span> Log a call</button>`)}
      <div class="filter-bar">
        <div class="filter-group"><div class="segmented" role="group" aria-label="Filter calls">
          <button type="button" data-call-filter="all" class="${state.callFilter === "all" ? "active" : ""}">All calls</button>
          <button type="button" data-call-filter="incoming" class="${state.callFilter === "incoming" ? "active" : ""}">Incoming</button>
          <button type="button" data-call-filter="outgoing" class="${state.callFilter === "outgoing" ? "active" : ""}">Outgoing</button>
        </div><span class="badge">${filtered.length} records</span></div>
        <input class="search-box" type="search" id="call-search" placeholder="Search client, staff, notes…" value="${escapeHtml(state.callSearch)}" aria-label="Search calls">
      </div>
      <section class="table-card"><div class="table-wrap"><table>
        <thead><tr><th>Date / time</th><th>Client / phone</th><th>Direction</th><th>Staff / outcome</th><th>Follow-up</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${callRows(filtered)}</tbody>
      </table></div></section>`;
  }

  function attendanceHours(entry) {
    const status = (entry.status || "").toLowerCase();
    const mode = (entry.workMode || "").toLowerCase();
    if (/leave|sick/.test(status)) return 8;
    if (isPublicHoliday(entry)) return 8;
    if (/client|direct|remote|home/.test(mode)) return 8;
    const presentInOffice = /present/.test(status) && /office/.test(mode);
    if (!presentInOffice && /present/.test(status)) return 8;
    if (entry.timeIn && entry.timeOut) {
      const [inHour, inMinute] = entry.timeIn.split(":").map(Number);
      const [outHour, outMinute] = entry.timeOut.split(":").map(Number);
      let duration = (outHour * 60 + outMinute) - (inHour * 60 + inMinute);
      if (duration < 0) duration += 24 * 60;
      return Math.max(0, duration / 60 - 1);
    }
    return Number(entry.hoursWorked) || 0;
  }

  function attendanceRows(entries) {
    if (!entries.length) return `<tr><td class="table-empty" colspan="8">No attendance entries for this date.</td></tr>`;
    return entries.map((entry) => `<tr>
      <td><div class="table-primary">${escapeHtml(entry.staff)}</div><div class="table-secondary">${escapeHtml(attendanceWorkMode(entry))}</div></td>
      <td>${badge(entry.status)}</td>
      <td>${formatTime(entry.timeIn)}${entry.timeOut ? ` – ${formatTime(entry.timeOut)}` : ""}</td>
      <td><strong>${formatHours(attendanceHours(entry))}</strong></td>
      <td>${escapeHtml(entry.location || "—")}</td>
      <td>${formatHours(entry.expectedHours || 8)}</td>
      <td>${escapeHtml(entry.notes || "—")}</td>
      <td><div class="table-actions"><button class="icon-button" type="button" aria-label="Edit attendance" title="Edit" data-action="edit-attendance" data-id="${escapeHtml(entry.id)}">✎</button><button class="icon-button" type="button" aria-label="Delete attendance" title="Delete" data-action="delete-attendance" data-id="${escapeHtml(entry.id)}">×</button></div></td>
    </tr>`).join("");
  }

  function renderAttendance() {
    const entries = state.data.attendance.filter((entry) => entry.date === state.attendanceDay)
      .sort((a, b) => a.staff.localeCompare(b.staff));
    const hours = entries.reduce((sum, entry) => sum + attendanceHours(entry), 0);
    const present = entries.filter((entry) => attendanceDayKind(entry) === "present").length;
    return `
      ${pageHeading("DAILY REGISTER", "Attendance", "Capture staff presence, work mode, time, and client visits.", `<button class="btn btn-primary" type="button" data-action="new-attendance"><span>＋</span> Add attendance</button>`)}
      <div class="filter-bar"><div class="filter-group"><label for="attendance-day" class="field-hint">Showing entries for</label><input id="attendance-day" class="field-control" type="date" value="${escapeHtml(state.attendanceDay)}"></div><span class="badge">${entries.length} staff entries</span></div>
      <section class="stats-grid">
        ${statCard("Present / partial", present, `For ${formatDate(state.attendanceDay)}`, "◷")}
        ${statCard("Hours worked", formatHours(hours), "Office hours use recorded times; leave and sick days count as 8 hours", "⌛")}
        ${statCard("On leave / sick", entries.filter((entry) => /leave|sick/i.test(entry.status)).length, "Leave and sick leave", "＋")}
        ${statCard("Client work", entries.filter((entry) => /client/i.test(entry.workMode || "") || entry.location).length, "Entries with client work or location", "⌖")}
      </section>
      <section class="table-card"><header class="table-card-header"><div><h2>Staff attendance</h2><p>Present office shifts use recorded times minus a one-hour lunch break. Leave and sick days count as 8 hours; partial shifts use recorded times.</p></div></header><div class="table-wrap"><table>
        <thead><tr><th>Staff / work mode</th><th>Status</th><th>Time in / out</th><th>Hours</th><th>Client / location</th><th>Expected</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${attendanceRows(entries)}</tbody>
      </table></div></section>`;
  }

  function meetingRows(meetings) {
    if (!meetings.length) return `<tr><td class="table-empty" colspan="6">No meetings scheduled. Add one to your calendar.</td></tr>`;
    return meetings.map((meeting) => `<tr>
      <td>${formatDate(meeting.date)}</td><td><div class="table-primary">${meeting.allDay ? "All day" : `${formatTime(meeting.startTime)} – ${formatTime(meeting.endTime)}`}</div></td>
      <td><div class="table-primary">${escapeHtml(meeting.subject)}</div><div class="table-secondary">${escapeHtml(meeting.category || "Appointment")}${meeting.importedFromOutlook ? " · Outlook" : ""}${meeting.notes ? ` · ${escapeHtml(meeting.notes)}` : ""}</div></td>
      <td>${escapeHtml(meeting.location || "—")}</td><td>${escapeHtml(meeting.organizer || "—")}</td>
      <td><div class="table-actions"><button class="icon-button" type="button" aria-label="Edit meeting" title="Edit" data-action="edit-meeting" data-id="${escapeHtml(meeting.id)}">✎</button><button class="icon-button" type="button" aria-label="Delete meeting" title="Delete" data-action="delete-meeting" data-id="${escapeHtml(meeting.id)}">×</button></div></td>
    </tr>`).join("");
  }

  function renderMeetings() {
    const meetings = [...state.data.meetings].sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
    return `
      ${pageHeading("DAILY SCHEDULE", "Meetings & appointments", "View Outlook appointments and meetings you have added here.", `<div class="button-row"><button class="btn btn-secondary" type="button" data-action="import-calendar">↑ Import Outlook calendar</button><button class="btn btn-primary" type="button" data-action="new-meeting"><span>＋</span> Add meeting</button><input id="calendar-import-file" type="file" accept=".ics,.ical,text/calendar" hidden></div>`)}
      <div class="notice"><strong>Import Outlook calendar:</strong> in classic Outlook, open Calendar, choose <em>File → Save Calendar</em>, select <em>More Options</em> and a date range, then save as an iCalendar (<code>.ics</code>) file. In Outlook on the web or new Outlook, use Calendar settings / sharing to export or publish an iCalendar file. Choose Import Outlook calendar and select the downloaded file. The file is read in this browser only; it is not uploaded or connected to your account. Re-import an updated export to refresh matching appointments. Recurring meetings are imported only as the events/occurrences included in the exported file.</div>
      ${state.meetingImportStatus ? `<div class="directory-status" role="status">${escapeHtml(state.meetingImportStatus)}</div>` : ""}
      <section class="table-card"><header class="table-card-header"><div><h2>Your schedule</h2><p>${meetings.length} ${meetings.length === 1 ? "appointment" : "appointments"}</p></div></header><div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Time</th><th>Subject</th><th>Location</th><th>Organizer</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${meetingRows(meetings)}</tbody>
      </table></div></section>`;
  }

  function directoryRows(items, kind) {
    if (!items.length) return `<tr><td class="table-empty" colspan="${kind === "client" ? 5 : 3}">No ${kind} contacts yet. ${kind === "client" ? "Add one to build your local directory." : "Search your work directory or add a contact manually."}</td></tr>`;
    return items.map((item) => `<tr><td><div class="table-primary">${escapeHtml(item.name)}</div></td>
      ${kind === "client" ? `<td>${escapeHtml(item.phone || "—")}${item.alternatePhone ? `<div class="table-secondary">Alt: ${escapeHtml(item.alternatePhone)}</div>` : ""}</td><td>${escapeHtml(item.email || "—")}</td><td>${escapeHtml(item.notes || "—")}</td>` : `<td>${escapeHtml(item.email || "—")}</td>`}
      <td><div class="table-actions"><button class="icon-button" type="button" aria-label="Delete ${kind}" title="Delete" data-action="delete-directory" data-kind="${kind}" data-id="${escapeHtml(item.id)}">×</button></div></td></tr>`).join("");
  }

  function renderDirectory() {
    const allClients = [...state.data.clients].sort((a, b) => a.name.localeCompare(b.name));
    const query = state.directorySearch.trim().toLocaleLowerCase();
    const clients = allClients.filter((client) => !query || [client.name, client.phone, client.alternatePhone, client.email, client.notes]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query)));
    const pageSize = 50;
    const pageCount = Math.max(1, Math.ceil(clients.length / pageSize));
    state.directoryPage = Math.min(state.directoryPage, pageCount - 1);
    const visibleClients = clients.slice(state.directoryPage * pageSize, (state.directoryPage + 1) * pageSize);
    const staff = [...state.data.staff].sort((a, b) => a.name.localeCompare(b.name));
    return `
      ${pageHeading("CONTACTS", "Directory", "Keep client and staff contacts together for faster call and attendance entry.", `<div class="button-row"><button class="btn btn-secondary" type="button" data-action="import-clients">↑ Import contacts</button><button class="btn btn-secondary" type="button" data-action="new-staff">＋ Add staff</button><button class="btn btn-primary" type="button" data-action="new-client">＋ Add client</button><input id="client-import-file" type="file" accept=".csv,text/csv" hidden></div>`)}
      <div class="notice"><strong>Import contacts:</strong> export your Outlook contacts as a CSV file, then choose Import contacts. Outlook fields for names, companies, emails, phone numbers, and notes are recognized. Workbook client CSV files are supported too. Matching names are merged instead of duplicated. Imported contacts appear in Clients; staff directory search is separate.</div>
      <section class="table-card"><header class="table-card-header"><div><h2>Clients</h2><p>${clients.length} matching · ${allClients.length} total contacts</p></div><input class="search-box" id="directory-search" type="search" placeholder="Search name, phone, notes…" value="${escapeHtml(state.directorySearch)}" aria-label="Search clients"></header><div class="table-wrap"><table>
        <thead><tr><th>Client / contact</th><th>Phone</th><th>Email</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${directoryRows(visibleClients, "client")}</tbody></table></div>
        ${clients.length > pageSize ? `<div class="table-pagination"><span>Showing ${state.directoryPage * pageSize + 1}–${Math.min((state.directoryPage + 1) * pageSize, clients.length)} of ${clients.length}</span><div class="button-row"><button class="btn btn-secondary btn-small" type="button" data-action="directory-page" data-page="${state.directoryPage - 1}" ${state.directoryPage === 0 ? "disabled" : ""}>Previous</button><button class="btn btn-secondary btn-small" type="button" data-action="directory-page" data-page="${state.directoryPage + 1}" ${state.directoryPage >= pageCount - 1 ? "disabled" : ""}>Next</button></div></div>` : ""}</section>
      <section class="table-card section-spacer"><header class="table-card-header staff-directory-header"><div><h2>Staff</h2><p>${staff.length} saved contacts · Search your work account's directory</p></div><div class="staff-directory-tools"><input class="search-box" id="staff-search" type="search" value="${escapeHtml(state.staffSearch)}" placeholder="Search work directory…" aria-label="Search work directory"><button class="btn btn-primary" type="button" data-action="search-work-directory">Search</button><button class="icon-button" type="button" aria-label="Configure work directory" title="Configure work directory" data-action="configure-work-directory">⚙</button></div></header>
        <div class="directory-status" id="staff-directory-status" role="status">${escapeHtml(state.staffSearchStatus || (workAccountSettings.clientId ? "Search your organization's Microsoft 365 directory by name or email." : "Connect an Entra app registration to search your organization's directory."))}</div>
        ${state.staffResults.length ? `<div class="table-wrap staff-results"><table><thead><tr><th>Work directory result</th><th>Job title</th><th></th></tr></thead><tbody>${state.staffResults.map((person) => {
          const exists = staff.some((entry) => (entry.email || "").toLowerCase() === person.email.toLowerCase() || (entry.name || "").toLowerCase() === person.name.toLowerCase());
          return `<tr><td><div class="table-primary">${escapeHtml(person.name)}</div><div class="table-secondary">${escapeHtml(person.email)}</div></td><td>${escapeHtml(person.jobTitle || "—")}</td><td><div class="table-actions">${exists ? `<span class="badge badge-green">Added</span>` : `<button class="btn btn-secondary btn-small" type="button" data-action="add-work-staff" data-id="${escapeHtml(person.id)}">Add to staff</button>`}</div></td></tr>`;
        }).join("")}</tbody></table></div>` : ""}
        <div class="table-wrap"><table><thead><tr><th>Staff member</th><th>Email</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${directoryRows(staff, "staff")}</tbody></table></div></section>`;
  }

  function reportDateControl() {
    return `<div class="report-controls"><label for="report-start">Week starting</label><input id="report-start" class="field-control" type="date" value="${escapeHtml(state.reportStart)}"></div>`;
  }

  function reportWeekDates() {
    return Array.from({ length: 5 }, (_, index) => addDays(state.reportStart, index));
  }

  function attendanceDayKind(entry) {
    const status = (entry.status || "").toLowerCase();
    if (/sick/.test(status)) return "sick";
    if (/leave/.test(status)) return "leave";
    if (isPublicHoliday(entry)) return "public-holiday";
    if (/absent/.test(status)) return "absent";
    if (/present|partial/.test(status)) return "present";
    return "other";
  }

  function isPublicHoliday(entry) {
    return /public\s+holiday/i.test(entry.workMode || "");
  }

  function attendanceWorkMode(entry) {
    const kind = attendanceDayKind(entry);
    return ["leave", "sick", "public-holiday"].includes(kind) ? "—" : entry.workMode || "—";
  }

  function weeklyWorkedHours(entry) {
    const kind = attendanceDayKind(entry);
    if (kind === "leave" || kind === "sick" || kind === "public-holiday") return 8;
    return kind === "present" ? attendanceHours(entry) : 0;
  }

  function renderCallReport() {
    const calls = currentWeekCalls();
    const incoming = calls.filter((call) => call.direction === "Incoming").length;
    const outgoing = calls.filter((call) => call.direction === "Outgoing").length;
    const succeeded = calls.filter(isSuccessfulCall).length;
    const callbackCompleted = calls.filter(isCallbackCompleted).length;
    const pending = pendingCallbackCount(calls);
    const unavailable = calls.filter((call) => /unavailable|unreachable/i.test(call.outcome || "")).length;
    const days = Array.from({ length: 5 }, (_, index) => {
      const date = addDays(state.reportStart, index);
      const dayCalls = calls.filter((call) => call.date === date);
      const dayIncoming = dayCalls.filter((call) => call.direction === "Incoming").length;
      const dayOutgoing = dayCalls.filter((call) => call.direction === "Outgoing").length;
      return {
        date,
        incoming: dayIncoming,
        outgoing: dayOutgoing,
        total: dayIncoming + dayOutgoing,
        label: formatDate(date, { weekday: "long" })
      };
    });
    const busiest = Math.max(0, ...days.map((day) => day.total));
    const busiestDays = busiest ? days.filter((day) => day.total === busiest).map((day) => day.label).join(", ") : "—";
    const completed = succeeded + callbackCompleted;
    const completionRate = calls.length ? Math.round(completed / calls.length * 100) : 0;
    const otherOutcomes = calls.filter((call) =>
      !isSuccessfulCall(call) &&
      !isCallbackCompleted(call) &&
      !isOpenCallback(call) &&
      !/unavailable|unreachable/i.test(call.outcome || "")
    ).length;
    const narrative = calls.length
      ? `${calls.length} calls were logged: ${incoming} incoming and ${outgoing} outgoing. ${succeeded} call${succeeded === 1 ? " outcome was" : " outcomes were"} successful, and ${callbackCompleted} failed attempt${callbackCompleted === 1 ? " had" : "s had"} a callback completed. Together, ${completed} of ${calls.length} calls or callback follow-ups were completed (${completionRate}%). ${pending} callback thread${pending === 1 ? " remains" : "s remain"} pending, and ${unavailable} were unavailable or unreachable. ${busiest ? `${busiestDays} ${busiest === 1 ? "was" : "were"} busiest with ${busiest} call${busiest === 1 ? "" : "s"}.` : "There was no call activity on the five workdays."}`
      : "No calls were logged during this Monday–Friday workweek.";
    return `
      ${pageHeading("CALL ACTIVITY", "Weekly calls", "Workbook-style Monday–Friday call summary, callback status, and daily activity.", `<div class="button-row">${reportDateControl()}<button class="btn btn-secondary btn-small" type="button" data-action="export-csv">Export calls CSV</button></div>`)}
      <section class="weekly-period">
        <div class="weekly-period-summary">
          <div><span>Week Start</span><strong>${formatDate(state.reportStart)}</strong></div>
          <div><span>Week End</span><strong>${formatDate(addDays(state.reportStart, 4))}</strong></div>
          <div><span>Working days</span><strong>Monday – Friday · 5 days</strong></div>
        </div>
        <div class="workweek-dates">${days.map((day) => `<div class="workday-date"><span>${escapeHtml(day.label)}</span><strong>${formatDate(day.date)}</strong></div>`).join("")}</div>
      </section>
      <section class="stats-grid">
        ${statCard("Incoming Calls", incoming, "Received during the workweek", "↙")}
        ${statCard("Outgoing Calls", outgoing, "Made during the workweek", "↗")}
        ${statCard("Total Calls", calls.length, "Monday to Friday", "☎")}
        ${statCard("Succeeded", succeeded, "Successful call outcomes", "✓")}
        ${statCard("Pending Callbacks", pending, "Distinct client and staff threads", "↻")}
        ${statCard("Completion Rate", `${completionRate}%`, `${succeeded} succeeded + ${callbackCompleted} callback completed`, "✓")}
        ${statCard("Unavailable / Unreachable", unavailable, "Calls with these outcomes", "×")}
        ${statCard("Busiest Day", busiestDays, busiest ? `${busiest} call${busiest === 1 ? "" : "s"}` : "No calls this week", "▦")}
      </section>
      <section class="report-grid">
        <article class="panel"><header class="panel-header"><div><h2>Outcome groups</h2><p>Callback completion is matched by client, staff, and call time.</p></div></header>
          <div class="metric-list">
            <div class="metric-row"><span>Succeeded call outcomes</span><strong>${succeeded}</strong></div>
            <div class="metric-row"><span>Callback completed (initial call failed)</span><strong>${callbackCompleted}</strong></div>
            <div class="metric-row"><span>Pending callback threads</span><strong>${pending}</strong></div>
            <div class="metric-row"><span>Unavailable / unreachable</span><strong>${unavailable}</strong></div>
            <div class="metric-row"><span>Other outcomes</span><strong>${otherOutcomes}</strong></div>
          </div>
        </article>
        <article class="panel"><header class="panel-header"><div><h2>Weekly summary</h2><p>Incoming and outgoing activity by weekday</p></div></header>
          <div class="table-wrap"><table class="weekly-calls-table"><thead><tr><th>Day</th><th>Incoming</th><th>Outgoing</th><th>Total</th></tr></thead><tbody>${days.map((day) => `<tr><td>${escapeHtml(day.label)}</td><td>${day.incoming}</td><td>${day.outgoing}</td><td><strong>${day.total}</strong></td></tr>`).join("")}<tr class="weekly-calls-total"><td>Week total</td><td>${incoming}</td><td>${outgoing}</td><td>${calls.length}</td></tr></tbody></table></div>
        </article>
      </section>
      <section class="panel section-spacer weekly-call-narrative"><header class="panel-header"><div><h2>Summary</h2><p>Weekly narrative</p></div></header><p>${escapeHtml(narrative)}</p></section>
      <section class="table-card section-spacer"><header class="table-card-header"><div><h2>Calls made during the week</h2><p>${calls.length} incoming and outgoing call record${calls.length === 1 ? "" : "s"}</p></div></header>
        <div class="table-wrap"><table><thead><tr><th>Date / time</th><th>Client / phone</th><th>Direction</th><th>Staff / outcome</th><th>Follow-up status</th><th>Call record / notes</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${callRows(sortedByNewest(calls))}</tbody></table></div>
      </section>`;
  }

  function renderAttendanceReport() {
    const attendance = currentWeekAttendance();
    const dates = reportWeekDates();
    const summary = weeklyAttendanceSummary(attendance);
    const targetHours = summary.length * 40;
    const hours = summary.reduce((sum, row) => sum + row.totalHours, 0);
    const variance = hours - targetHours;
    const coverage = targetHours ? Math.round(hours / targetHours * 1000) / 10 : 0;
    return `
      <div class="page-heading">
        <div class="attendance-report-heading">
          <img class="attendance-report-logo" src="./assets/grant-thornton-logo.png" alt="Grant Thornton">
          <div><div class="eyebrow">STAFF ACTIVITY</div><h1>Weekly attendance</h1><p>Monday–Friday attendance totals, work hours, approved leave, sick leave, and public holidays.</p></div>
        </div>
        <div class="button-row">${reportDateControl()}<button class="btn btn-secondary btn-small" type="button" title="Choose Save as PDF in the print dialog" data-action="download-attendance-report">Download attendance report</button></div>
      </div>
      <section class="panel weekly-period">
        <div class="weekly-period-summary">
          <div><span>Week Start</span><strong>${formatDate(state.reportStart)}</strong></div>
          <div><span>Week End</span><strong>${formatDate(dates[4])}</strong></div>
          <div><span>Working days</span><strong>Monday – Friday · 5 days</strong></div>
        </div>
        <div class="workweek-dates">${dates.map((date) => `<div class="workday-date"><span>${formatDate(date, { weekday: "long" })}</span><strong>${formatDate(date)}</strong></div>`).join("")}</div>
      </section>
      <section class="weekly-totals" aria-label="Weekly attendance totals">
        <div class="weekly-total"><span>Total Hours</span><strong>${formatHours(hours)}</strong></div>
        <div class="weekly-total"><span>Target Hours</span><strong>${formatHours(targetHours)}</strong></div>
        <div class="weekly-total"><span>Variance Hours</span><strong>${formatHours(variance)}</strong></div>
        <div class="weekly-total"><span>Coverage</span><strong>${coverage}%</strong></div>
      </section>
      <section class="table-card weekly-attendance-summary section-spacer"><header class="table-card-header"><div><h2>Weekly staff summary</h2><p>Each staff member has a 40-hour target across five workdays. Leave, sick leave, and public holidays count as 8 hours.</p></div></header>
        ${attendanceReportTable(summary)}
      </section>
      <section class="daily-attendance-list section-spacer" aria-label="Daily attendance for the selected workweek">
        ${dates.map((date) => dailyAttendanceReport(date, attendance.filter((entry) => entry.date === date))).join("")}
      </section>`;
  }

  function weeklyAttendanceSummary(entries) {
    const byStaff = new Map();
    state.data.staff.forEach((staff) => {
      if (staff.name) byStaff.set(staff.name, []);
    });
    entries.forEach((entry) => {
      if (!entry.staff) return;
      if (!byStaff.has(entry.staff)) byStaff.set(entry.staff, []);
      byStaff.get(entry.staff).push(entry);
    });
    return [...byStaff.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, records]) => {
      const byDay = new Map();
      records.forEach((entry) => {
        const bucket = byDay.get(entry.date) || [];
        bucket.push(entry);
        byDay.set(entry.date, bucket);
      });
      let presentDays = 0;
      let leaveDays = 0;
      let sickDays = 0;
      let publicHolidayDays = 0;
      let remoteDays = 0;
      let clientDays = 0;
      let officeDays = 0;
      let workedHours = 0;
      byDay.forEach((dayEntries) => {
        const kinds = dayEntries.map(attendanceDayKind);
        const worked = kinds.includes("present");
        if (worked) presentDays += 1;
        if (kinds.includes("leave")) leaveDays += 1;
        if (kinds.includes("sick")) sickDays += 1;
        if (kinds.includes("public-holiday")) publicHolidayDays += 1;
        dayEntries.forEach((entry) => {
          if (attendanceDayKind(entry) === "present") workedHours += attendanceHours(entry);
        });
        if (!worked) return;
        let remoteWork = false;
        let clientWork = false;
        let officeWork = false;
        dayEntries.forEach((entry) => {
          const mode = (entry.workMode || "").toLowerCase();
          if (/remote|home/.test(mode)) remoteWork = true;
          else if (/client|direct/.test(mode) || (/other/.test(mode) && entry.location)) clientWork = true;
          else if (/office/.test(mode)) officeWork = true;
        });
        if (remoteWork) remoteDays += 1;
        if (clientWork) clientDays += 1;
        else if (officeWork) officeDays += 1;
      });
      const WEEKLY_TARGET_HOURS = 40;
      const leaveHours = leaveDays * 8;
      const sickHours = sickDays * 8;
      const publicHolidayHours = publicHolidayDays * 8;

      const workedHoursRounded = Math.round(workedHours * 100) / 100;
      const totalHours = Math.round((workedHoursRounded + leaveHours + sickHours + publicHolidayHours) * 100) / 100;

      const variance = Math.round((totalHours - WEEKLY_TARGET_HOURS) * 100) / 100;

      let flags = "On Target";
      let flagClass = "";
      let varianceSign = "";

      if (variance < -0.005) {
        flags = "Below Target";
        flagClass = "attendance-flag-below";
        varianceSign = "−";
      } else if (variance > 0.005) {
        flags = "Above Target";
        flagClass = "attendance-flag-above";
        varianceSign = "+";
      }

      return {
        name,
        presentDays,
        leaveDays,
        sickDays,
        publicHolidayDays,
        remoteDays,
        publicHolidayHours,
        clientDays,
        officeDays,
        hoursWorked: workedHoursRounded,
        leaveHours,
        sickHours,
        totalHours,
        targetHours: WEEKLY_TARGET_HOURS,
        variance,
        flags,
        flagClass,
        varianceSign
      };
    });
  }

  function attendanceReportTable(rows) {
    if (!rows.length) return emptyState("No staff in the directory", "Add staff or attendance entries to build the weekly summary.");
    return `<div class="table-wrap"><table class="weekly-attendance-table"><thead>
<tr>
<th>Staff Name</th>
<th>Present Days</th>
<th>Leave Days</th>
<th>Sick Days</th>
<th>Public Holidays</th>
<th>Remote Days</th>
<th>Client Days</th>
<th>Office Days</th>
<th>Hours Worked</th>
<th>Leave Hours</th>
<th>Sick Hours</th>
<th>Public Holiday Hours</th>
<th>Total Hours</th>
<th>Target Hours</th>
<th>Variance Hours</th>
<th>Flags</th>
</tr>
</thead><tbody>${rows.map((row) => `<tr>
      <td><strong>${escapeHtml(row.name)}</strong></td>
<td>${row.presentDays}</td>
<td>${row.leaveDays}</td>
<td>${row.sickDays}</td>
<td>${row.publicHolidayDays}</td>
<td>${row.remoteDays}</td>
<td>${row.clientDays}</td>
<td>${row.officeDays}</td>

<td>${formatHours(row.hoursWorked)}</td>
<td>${formatHours(row.leaveHours)}</td>
<td>${formatHours(row.sickHours)}</td>
<td>${formatHours(row.publicHolidayHours)}</td>

<td><strong>${formatHours(row.totalHours)}</strong></td>

<td>${formatHours(row.targetHours)}</td>

<td class="${row.variance < 0 ? 'variance-negative' : row.variance > 0 ? 'variance-positive' : ''}">
  ${row.varianceSign}${formatHours(Math.abs(row.variance))}
</td>

<td>
  <span class="attendance-flag ${row.flagClass}">
    ${row.flags}
  </span>
</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function dailyAttendanceReport(date, entries) {
    const dayLabel = formatDate(date, { weekday: "long", day: "numeric", month: "short", year: "numeric" });
    const sorted = [...entries].sort((a, b) => a.staff.localeCompare(b.staff));
    return `<section class="table-card daily-attendance-card"><header class="table-card-header"><div><h2>${dayLabel}</h2><p>${sorted.length} attendance ${sorted.length === 1 ? "entry" : "entries"}</p></div></header>
      <div class="table-wrap"><table><thead><tr><th>Staff Name</th><th>Status</th><th>Work Mode</th><th>Hours Worked</th><th>Time In / Out</th><th>Client / Location</th><th>Notes</th></tr></thead><tbody>${sorted.length ? sorted.map((entry) => `<tr>
        <td><strong>${escapeHtml(entry.staff)}</strong></td>
        <td>${badge(entry.status)}</td>
        <td>${escapeHtml(attendanceWorkMode(entry))}</td>
        <td>${formatHours(weeklyWorkedHours(entry))}</td>
        <td>${formatTime(entry.timeIn)}${entry.timeOut ? ` – ${formatTime(entry.timeOut)}` : ""}</td>
        <td>${escapeHtml(entry.location || "—")}</td>
        <td>${escapeHtml(entry.notes || "—")}</td>
      </tr>`).join("") : `<tr><td class="table-empty" colspan="7">No attendance entries recorded for this workday.</td></tr>`}</tbody></table></div>
    </section>`;
  }

  function field(label, name, value = "", options = {}) {
    const required = options.required ? " required" : "";
    const hint = options.hint ? `<span class="field-hint">${escapeHtml(options.hint)}</span>` : "";
    const optional = options.required ? "" : `<span class="optional"> · optional</span>`;
    let control = "";
    if (options.type === "select") {
      const emptyOption = options.emptyOption
        ? `<option value="" ${value ? "" : "selected"}>${escapeHtml(options.emptyOption)}</option>`
        : "";
      control = `<select class="field-control" id="field-${name}" name="${name}"${required}>${emptyOption}${options.options.map((option) => `<option value="${escapeHtml(option)}" ${value === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
    } else if (options.type === "textarea") {
      control = `<textarea id="field-${name}" name="${name}"${required} placeholder="${escapeHtml(options.placeholder || "")}">${escapeHtml(value)}</textarea>`;
    } else {
      const list = options.list ? ` list="${options.list}"` : "";
      control = `<input class="field-control" id="field-${name}" name="${name}" type="${options.type || "text"}" value="${escapeHtml(value)}" placeholder="${escapeHtml(options.placeholder || "")}"${list}${required}${options.step ? ` step="${options.step}"` : ""}>`;
    }
    return `<div class="field${options.wide ? " wide" : ""}"><label for="field-${name}">${escapeHtml(label)}${optional}</label>${control}${hint}</div>`;
  }

  function datalists() {
    return `<datalist id="clients-list">${state.data.clients.map((client) => `<option value="${escapeHtml(client.name)}"></option>`).join("")}</datalist><datalist id="staff-list">${state.data.staff.map((staff) => `<option value="${escapeHtml(staff.name)}"></option>`).join("")}</datalist>`;
  }

  function openModal(title, subtitle, formName, body, submitLabel = "Save entry", recordId = "") {
    modalRoot.innerHTML = `<div class="modal-root-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-head"><div><h2 id="modal-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" type="button" aria-label="Close dialog" data-action="close-modal">×</button></header>
      <form data-form="${formName}" data-record-id="${escapeHtml(recordId)}"><div class="modal-body">${body}</div><footer class="modal-foot"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${escapeHtml(submitLabel)}</button></footer></form>
    </section></div>`;
    modalRoot.querySelector(".modal-root-backdrop").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    modalRoot.querySelector("input,select,textarea")?.focus();
    document.addEventListener("keydown", handleModalKeydown, { once: true });
  }

  function handleModalKeydown(event) {
    if (event.key === "Escape" && modalRoot.firstElementChild) closeModal();
    else if (modalRoot.firstElementChild) document.addEventListener("keydown", handleModalKeydown, { once: true });
  }

  function closeModal() {
    modalRoot.innerHTML = "";
  }

  function findRecord(collection, recordId) {
    return state.data[collection].find((item) => item.id === recordId);
  }

  function showCallForm(recordId = "", draft = {}) {
    const existing = recordId ? findRecord("calls", recordId) : null;
    const value = (key, fallback = "") => existing?.[key] ?? draft[key] ?? fallback;
    const direction = value("direction", "Incoming");
    const currentDate = toDateInput(new Date());
    const body = `<div class="form-grid">
      ${field("Direction", "direction", direction, { type: "select", options: ["Incoming", "Outgoing"], required: true })}
      ${field("Date", "date", value("date", currentDate), { type: "date", required: true })}
      ${field("Time", "time", value("time"), { type: "time", required: true })}
      ${field("Client", "client", value("client"), { required: true, list: "clients-list", placeholder: "Client or caller name", hint: "Selecting a client automatically stamps the current date and time." })}
      ${field("Phone", "phone", value("phone"), { type: "tel", placeholder: "Phone number" })}
      ${field(direction === "Incoming" ? "Staff requested" : "Staff requesting", "staff", value("staff"), { list: "staff-list", placeholder: "Staff member's name" })}
      ${field("Outcome", "outcome", value("outcome", "Succeeded"), { type: "select", options: ["Succeeded", "Engaged", "Callback Requested", "No Answer", "Unavailable", "Unreachable", "Voicemail", "Other"], required: true })}
      ${field("Follow-up status", "followUp", value("followUp", "Not Required"), { type: "select", options: ["Not Required", "Callback Pending", "In Progress", "Completed", "Callback Completed"] })}
      ${field("Call record", "record", value("record"), { wide: true, placeholder: "Brief summary of the conversation" })}
      ${field("Notes", "notes", value("notes"), { type: "textarea", wide: true, placeholder: "Additional details or next steps" })}
    </div>${datalists()}`;
    openModal(existing ? "Edit call" : "Log a call", "Capture the essentials of a client conversation.", "call", body, existing ? "Save changes" : "Save call", recordId);
  }

  function showAttendanceForm(recordId = "", draft = {}) {
    const existing = recordId ? findRecord("attendance", recordId) : null;
    const value = (key, fallback = "") => existing?.[key] ?? draft[key] ?? fallback;
    const body = `<div class="form-grid">
      ${field("Staff name", "staff", value("staff"), { required: true, list: "staff-list", placeholder: "Enter staff name" })}
      ${field("Date", "date", value("date", state.attendanceDay), { type: "date", required: true })}
      ${field("Status", "status", value("status", "Present"), { type: "select", options: ["Present", "Partial", "Leave", "Sick Leave", "Absent"], required: true })}
      ${field("Work mode", "workMode", value("workMode", "Office"), { type: "select", options: ["Office", "Client Direct", "Office -> Client", "Remote", "Other", "Public Holiday"] })}
      ${field("Time in", "timeIn", value("timeIn"), { type: "time" })}
      ${field("Time out", "timeOut", value("timeOut"), { type: "time" })}
      ${field("Client / location", "location", value("location"), { placeholder: "Client visit, office, or location" })}
      ${field("Expected hours", "expectedHours", value("expectedHours", 8), { type: "number", step: "0.25", required: true })}
      ${field("Notes", "notes", value("notes"), { type: "textarea", wide: true, placeholder: "Optional attendance notes" })}
    </div>${datalists()}<p class="field-hint" style="margin:14px 0 0">For office shifts, enter start and end times; hours are calculated from the recorded interval less the one-hour lunch break. If those times are missing, only manually recorded hours are counted. Approved leave, sick leave, and public holidays count as 8 hours; remote, client-direct, and office-to-client days count as 8 hours. Partial office shifts use recorded times less lunch.</p>`;
    openModal(existing ? "Edit attendance" : "Add attendance", "Record one staff member's attendance for a day.", "attendance", body, existing ? "Save changes" : "Save attendance", recordId);
  }

  function showMeetingForm(recordId = "", draft = {}) {
    const existing = recordId ? findRecord("meetings", recordId) : null;
    const value = (key, fallback = "") => existing?.[key] ?? draft[key] ?? fallback;
    const body = `<div class="form-grid">
      ${field("Date", "date", value("date", today), { type: "date", required: true })}
      ${field("Subject", "subject", value("subject"), { required: true, placeholder: "Meeting or appointment" })}
      ${field("Start time", "startTime", value("startTime"), { type: "time", required: true })}
      ${field("End time", "endTime", value("endTime"), { type: "time", required: true })}
      ${field("Location", "location", value("location"), { placeholder: "Room or meeting link" })}
      ${field("Organizer", "organizer", value("organizer"), { list: "staff-list", placeholder: "Organizer name" })}
      ${field("Category", "category", value("category", "Meeting"), { type: "select", options: ["Meeting", "Appointment", "Training", "Internal", "Client", "Other"] })}
      ${field("Notes", "notes", value("notes"), { type: "textarea", wide: true, placeholder: "Optional details" })}
    </div>${datalists()}`;
    openModal(existing ? "Edit meeting" : "Add meeting", "Schedule an appointment in this browser.", "meeting", body, existing ? "Save changes" : "Save meeting", recordId);
  }

  function showDirectoryForm(kind, draft = {}) {
    const client = kind === "client";
    const body = `<div class="form-grid">
      ${field(client ? "Client name" : "Staff name", "name", draft.name || "", { required: true, placeholder: client ? "Company or contact" : "Staff member" })}
      ${field(client ? "Phone" : "Email", client ? "phone" : "email", draft[client ? "phone" : "email"] || "", { type: client ? "tel" : "email", placeholder: client ? "Phone number" : "name@example.com" })}
      ${client ? field("Alternate phone", "alternatePhone", draft.alternatePhone || "", { type: "tel", placeholder: "Optional alternate number" }) : ""}
      ${client ? field("Email", "email", draft.email || "", { type: "email", placeholder: "Optional email address" }) : ""}
      ${client ? field("Notes", "notes", draft.notes || "", { type: "textarea", wide: true, placeholder: "Optional client details" }) : ""}
    </div>`;
    openModal(client ? "Add client" : "Add staff", "Add a contact to your private, local directory.", client ? "client" : "staff", body, client ? "Save client" : "Save staff");
  }

  function showWorkDirectorySettings() {
    const body = `<div class="notice"><strong>Microsoft Entra app setup required.</strong> Register this website as a Single-page application (SPA), add this site's redirect URI, and grant the delegated Microsoft Graph permission <code>${WORK_DIRECTORY_SCOPE}</code>. Your organization may require administrator consent. Never enter a client secret here.</div>
      <div class="form-grid">
        ${field("Microsoft Entra tenant ID or domain", "tenantId", workAccountSettings.tenantId, { required: true, placeholder: "contoso.onmicrosoft.com or tenant ID" })}
        ${field("Application (client) ID", "clientId", workAccountSettings.clientId, { required: true, placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" })}
      </div>
      <p class="field-hint" style="margin:14px 0 0">Redirect URI for this website: <code>${escapeHtml(window.location.protocol === "file:" || window.location.origin === "null" ? "Unavailable when opened as a local file" : window.location.origin)}</code>. This searches work directory profiles only; it does not read email or calendar data.</p>`;
    openModal("Connect work directory", "Configure secure sign-in for Microsoft 365 staff search.", "work-directory-settings", body, "Save configuration");
  }

  function canUseWorkAccountAuth() {
    return window.location.protocol === "https:" ||
      (window.location.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname));
  }

  async function getWorkDirectoryClient() {
    if (!workAccountSettings.tenantId || !workAccountSettings.clientId) {
      showWorkDirectorySettings();
      throw new Error("Enter the Entra tenant and application ID before connecting.");
    }
    if (!canUseWorkAccountAuth()) {
      showWorkDirectorySettings();
      throw new Error("Microsoft sign-in requires HTTPS hosting or localhost. This page is currently opened as a local file.");
    }
    if (!msalClientPromise) {
      msalClientPromise = import("https://cdn.jsdelivr.net/npm/@azure/msal-browser@5.29.0/+esm").then(async ({ PublicClientApplication }) => {
        const client = new PublicClientApplication({
          auth: {
            clientId: workAccountSettings.clientId,
            authority: `https://login.microsoftonline.com/${encodeURIComponent(workAccountSettings.tenantId)}`,
            redirectUri: window.location.origin
          },
          cache: { cacheLocation: "sessionStorage" }
        });
        await client.initialize();
        return client;
      }).catch((error) => {
        msalClientPromise = undefined;
        throw new Error(`Could not load Microsoft sign-in: ${error.message}`);
      });
    }
    return msalClientPromise;
  }

  async function acquireWorkDirectoryToken(client) {
    let account = client.getActiveAccount() || client.getAllAccounts()[0];
    if (!account) {
      const login = await client.loginPopup({ scopes: [WORK_DIRECTORY_SCOPE] });
      account = login.account;
      if (!account) throw new Error("Microsoft sign-in did not return an account.");
      client.setActiveAccount(account);
    }
    try {
      const token = await client.acquireTokenSilent({ scopes: [WORK_DIRECTORY_SCOPE], account });
      return token.accessToken;
    } catch (error) {
      if (error.name !== "InteractionRequiredAuthError" && error.errorCode !== "interaction_required") throw error;
      const token = await client.acquireTokenPopup({ scopes: [WORK_DIRECTORY_SCOPE], account });
      return token.accessToken;
    }
  }

  async function searchWorkDirectory() {
    const query = state.staffSearch.trim().replace(/\s+/g, " ");
    state.staffResults = [];
    if (query.length < 2) {
      state.staffSearchStatus = "Enter at least 2 characters to search your work directory.";
      render();
      return;
    }
    if (!workAccountSettings.clientId || !workAccountSettings.tenantId) {
      showWorkDirectorySettings();
      return;
    }
    if (!canUseWorkAccountAuth()) {
      state.staffSearchStatus = "This local-file page cannot sign in. Host it over HTTPS or open it on localhost, then add that URL as the app's SPA redirect URI.";
      render();
      return;
    }

    state.staffSearchStatus = "Connecting to Microsoft 365…";
    render();
    try {
      const client = await getWorkDirectoryClient();
      const accessToken = await acquireWorkDirectoryToken(client);
      const escapedQuery = query.replace(/'/g, "''");
      const filter = ["displayName", "mail", "userPrincipalName"]
        .map((property) => `startswith(${property},'${escapedQuery}')`)
        .join(" or ");
      const params = new URLSearchParams({
        "$filter": filter,
        "$select": "id,displayName,mail,userPrincipalName,jobTitle",
        "$top": "25",
        "$count": "true"
      });
      const response = await fetch(`https://graph.microsoft.com/v1.0/users?${params}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ConsistencyLevel: "eventual"
        }
      });
      const result = await response.json();
      if (!response.ok) {
        const detail = result.error?.message || `Microsoft Graph returned HTTP ${response.status}.`;
        throw new Error(detail);
      }
      state.staffResults = (result.value || []).filter((person) => person.displayName && (person.mail || person.userPrincipalName))
        .map((person) => ({
          id: person.id,
          name: person.displayName,
          email: person.mail || person.userPrincipalName,
          jobTitle: person.jobTitle || ""
        }));
      state.staffSearchStatus = state.staffResults.length
        ? `${state.staffResults.length} work directory result${state.staffResults.length === 1 ? "" : "s"} found. Add selected people to the local staff list.`
        : "No matching staff were found. Try a different name or email prefix.";
    } catch (error) {
      console.error("Microsoft work directory search failed.", error);
      state.staffResults = [];
      state.staffSearchStatus = error.message || "Work directory search failed.";
    }
    render();
  }

  function addWorkDirectoryStaff(personId) {
    const person = state.staffResults.find((result) => result.id === personId);
    if (!person) return;
    const duplicate = state.data.staff.some((entry) =>
      (entry.email || "").toLowerCase() === person.email.toLowerCase() ||
      (entry.name || "").toLowerCase() === person.name.toLowerCase()
    );
    if (duplicate) {
      toast("That staff member is already in your directory.");
      return;
    }
    const previousStaff = state.data.staff;
    state.data.staff = [...previousStaff, { id: id(), name: person.name, email: person.email }];
    if (!saveData()) {
      state.data.staff = previousStaff;
      return;
    }
    render();
    toast(`${person.name} added to staff.`);
  }

  async function handleFormSubmit(event) {
    const assistantForm = event.target.closest("form[data-assistant-form]");
    if (assistantForm) {
      event.preventDefault();
      submitAssistantQuery(assistantForm.elements.query.value);
      return;
    }
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (form.dataset.form === "cloud-login") {
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form).entries());
        await signInCloud(values.projectUrl, values.anonKey, values.email, values.password);
        closeModal();
        render();
        toast("Cloud storage connected. Your records are synced on this device and in Supabase.");
      } catch (error) {
        console.error("Could not connect to Supabase.", error);
        toast(`Could not connect to cloud storage: ${error.message}`);
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
      return;
    }
    if (form.dataset.form === "cloud-password") {
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form).entries());
        if (values.password !== values.confirmPassword) {
          toast("The passwords do not match.");
          form.elements.confirmPassword.focus();
          return;
        }
        await completeCloudPassword(values.password);
        closeModal();
        render();
        toast("Password saved. Your cloud workspace is synced.");
      } catch (error) {
        console.error("Could not complete cloud account setup.", error);
        toast(`Could not save your cloud password: ${error.message}`);
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
      return;
    }
    if (storageFault) {
      toast("Changes are disabled until you restore a valid backup.");
      return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    const recordId = form.dataset.recordId || "";
    const edit = recordId ? findRecord(collectionForForm(form.dataset.form), recordId) : null;

    let successMessage = "";
    if (form.dataset.form === "work-directory-settings") {
      const tenantId = values.tenantId.trim();
      const clientId = values.clientId.trim();
      if (!tenantId || !clientId) {
        toast("Enter both the tenant ID and application (client) ID.");
        return;
      }
      Object.assign(workAccountSettings, { tenantId, clientId });
      try {
        localStorage.setItem(WORK_ACCOUNT_KEY, JSON.stringify(workAccountSettings));
      } catch (error) {
        console.error("Could not save work directory configuration.", error);
        toast("Could not save the work directory configuration in this browser.");
        return;
      }
      msalClientPromise = undefined;
      closeModal();
      state.staffSearchStatus = "Configuration saved. Search your organization's Microsoft 365 directory by name or email.";
      render();
      return;
    } else if (form.dataset.form === "call") {
      const record = { ...values, id: edit?.id || id(), direction: values.direction, date: values.date, time: values.time };
      upsert("calls", record);
      successMessage = edit ? "Call updated." : "Call saved.";
    } else if (form.dataset.form === "attendance") {
      const record = { ...values, id: edit?.id || id(), expectedHours: Number(values.expectedHours) || 8 };
      upsert("attendance", record);
      state.attendanceDay = values.date;
      successMessage = edit ? "Attendance updated." : "Attendance saved.";
    } else if (form.dataset.form === "meeting") {
      if (values.endTime < values.startTime) {
        toast("End time must be after the start time.");
        form.querySelector('[name="endTime"]').focus();
        return;
      }
      const record = { ...(edit || {}), ...values, id: edit?.id || id() };
      upsert("meetings", record);
      successMessage = edit ? "Meeting updated." : "Meeting saved.";
    } else if (form.dataset.form === "client") {
      state.data.clients.push({ ...values, id: id() });
      successMessage = "Client added to your directory.";
    } else if (form.dataset.form === "staff") {
      state.data.staff.push({ ...values, id: id() });
      successMessage = "Staff member added to your directory.";
    }
    const saved = saveData();
    closeModal();
    render();
    if (saved) toast(successMessage);
  }

  function collectionForForm(formName) {
    return ({ call: "calls", attendance: "attendance", meeting: "meetings" })[formName];
  }

  function upsert(collection, record) {
    const index = state.data[collection].findIndex((item) => item.id === record.id);
    if (index >= 0) state.data[collection][index] = record;
    else state.data[collection].push(record);
  }

  function removeRecord(collection, recordId, message) {
    if (storageFault) {
      toast("Changes are disabled until you restore a valid backup.");
      return;
    }
    const deletedRecord = state.data[collection].find((item) => item.id === recordId);
    if (deletedRecord) {
      cloudTombstones = mergeTombstoneLists(cloudTombstones, [{
        keys: recordTombstoneKeys(collection, deletedRecord),
        deletedAt: new Date().toISOString()
      }]);
      persistCloudTombstones();
    }
    state.data[collection] = state.data[collection].filter((item) => item.id !== recordId);
    const saved = saveData();
    render();
    if (saved) toast(message);
  }

  function deleteAction(collection, recordId, name) {
    if (!window.confirm(`Delete this ${name}? This cannot be undone.`)) return;
    removeRecord(collection, recordId, `${name[0].toUpperCase()}${name.slice(1)} deleted.`);
  }

  function download(name, type, contentText) {
    const url = URL.createObjectURL(new Blob([contentText], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportBackup() {
    if (storageFault) {
      toast("Restore a valid backup before exporting saved data.");
      return;
    }
    download(`call-time-backup-${today}.json`, "application/json", JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...state.data }, null, 2));
    toast("Backup downloaded.");
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function exportCallsCsv() {
    const rows = [["Date", "Time", "Direction", "Client", "Phone", "Staff", "Outcome", "Follow-up Status", "Call Record", "Notes"]];
    currentWeekCalls().forEach((call) => rows.push([call.date, call.time, call.direction, call.client, call.phone, call.staff, call.outcome, call.followUp, call.record, call.notes]));
    download(`call-time-week-${state.reportStart}.csv`, "text/csv;charset=utf-8", rows.map((row) => row.map(csvCell).join(",")).join("\r\n"));
    toast("Weekly calls CSV downloaded.");
  }

  async function downloadAttendanceReport() {
    const logo = content.querySelector(".attendance-report-logo");
    if (!(logo instanceof HTMLImageElement)) {
      toast("The attendance report logo is missing. Refresh the page before downloading.");
      return;
    }

    const logoLoaded = logo.complete
      ? logo.naturalWidth > 0
      : await new Promise((resolve) => {
          logo.addEventListener("load", () => resolve(true), { once: true });
          logo.addEventListener("error", () => resolve(false), { once: true });
        });
    if (!logoLoaded) {
      console.error("Could not load the Grant Thornton logo for the attendance report.", logo.currentSrc);
      toast("The Grant Thornton logo could not be loaded; the report was not printed.");
      return;
    }

    const originalTitle = document.title;
    const cleanup = () => {
      document.body.classList.remove("printing-attendance-report");
      document.title = originalTitle;
    };

    document.body.classList.add("printing-attendance-report");
    document.title = `Call-Time-Attendance-${state.reportStart}`;
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
  }

  function unfoldIcalLines(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").reduce((lines, line) => {
      if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
      else lines.push(line);
      return lines;
    }, []);
  }

  function unescapeIcalText(value) {
    return value.replace(/\\[nN]/g, "\n").replace(/\\([\\,;])/g, "$1");
  }

  function parseIcalDate(value, parameters = "") {
    const raw = value.trim();
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
    if (dateOnly) return { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, time: "", allDay: true };
    const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(raw);
    if (!dateTime) throw new Error(`Unsupported calendar date: ${raw}`);
    const [, year, month, day, hour, minute, seconds = "00", utc] = dateTime;
    if (utc) {
      const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(seconds)));
      return {
        date: toDateInput(local),
        time: `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`,
        allDay: false
      };
    }
    return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}`, allDay: false, timezone: parameters.match(/(?:^|;)TZID=("[^"]+"|[^;:]+)/i)?.[1]?.replace(/^"|"$/g, "") || "" };
  }

  function parseIcalendar(text) {
    const lines = unfoldIcalLines(text.replace(/^\uFEFF/, ""));
    if (!lines.some((line) => line.trim().toUpperCase() === "BEGIN:VCALENDAR")) {
      throw new Error("This file is not a valid iCalendar export.");
    }
    const events = [];
    let current = null;
    for (const line of lines) {
      if (/^BEGIN:VEVENT$/i.test(line.trim())) {
        if (current) throw new Error("The calendar file contains a nested event.");
        current = {};
        continue;
      }
      if (/^END:VEVENT$/i.test(line.trim())) {
        if (!current) throw new Error("The calendar file contains an unmatched event end.");
        if (!/^CANCELLED$/i.test(current.status || "")) {
          if (!current.start || !current.subject) throw new Error("A calendar event is missing its start time or subject.");
          const end = current.end || {
            date: current.start.date,
            time: current.start.allDay ? "" : formatIcalDefaultEnd(current.start.date, current.start.time),
            allDay: current.start.allDay
          };
          events.push({
            externalUid: current.uid || "",
            recurrenceId: current.recurrenceId || "",
            date: current.start.date,
            startTime: current.start.time,
            endTime: end.time || "",
            allDay: current.start.allDay,
            subject: current.subject,
            location: current.location || "",
            organizer: current.organizer || "",
            category: "Meeting",
            notes: current.description || "",
            importedFromOutlook: true
          });
        }
        current = null;
        continue;
      }
      if (!current) continue;
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const property = line.slice(0, separator);
      const value = line.slice(separator + 1);
      const [propertyName, ...parameterParts] = property.split(";");
      const name = propertyName.toUpperCase();
      const parameters = `;${parameterParts.join(";")}`;
      if (name === "UID") current.uid = value.trim();
      else if (name === "RECURRENCE-ID") current.recurrenceId = value.trim();
      else if (name === "STATUS") current.status = value.trim();
      else if (name === "DTSTART") current.start = parseIcalDate(value, parameters);
      else if (name === "DTEND") current.end = parseIcalDate(value, parameters);
      else if (name === "SUMMARY") current.subject = unescapeIcalText(value.trim());
      else if (name === "LOCATION") current.location = unescapeIcalText(value.trim());
      else if (name === "DESCRIPTION") current.description = unescapeIcalText(value.trim());
      else if (name === "ORGANIZER") current.organizer = unescapeIcalText(value.replace(/^mailto:/i, "").trim());
    }
    if (current) throw new Error("The calendar file ends before an event is complete.");
    if (!events.length) throw new Error("No non-cancelled appointments were found in this calendar file.");
    return events;
  }

  function formatIcalDefaultEnd(date, time) {
    const start = dateFromInput(date);
    const [hour, minute] = time.split(":").map(Number);
    start.setHours(hour, minute + 30);
    return `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  }

  function calendarImportKey(event) {
    if (event.externalUid) return `${event.externalUid}|${event.recurrenceId || ""}`;
    return `${event.date}|${event.startTime}|${event.subject.toLocaleLowerCase()}`;
  }

  async function importCalendarFile(file) {
    try {
      const events = parseIcalendar(await file.text());
      const previousMeetings = state.data.meetings;
      const nextMeetings = previousMeetings.map((meeting) => ({ ...meeting }));
      const importedByKey = new Map(nextMeetings
        .filter((meeting) => meeting.importedFromOutlook)
        .map((meeting) => [calendarImportKey(meeting), meeting]));
      let added = 0;
      let updated = 0;
      events.forEach((event) => {
        const key = calendarImportKey(event);
        const existing = importedByKey.get(key);
        if (existing) {
          Object.assign(existing, event);
          updated += 1;
        } else {
          const record = { ...event, id: id() };
          nextMeetings.push(record);
          importedByKey.set(key, record);
          added += 1;
        }
      });
      state.data.meetings = nextMeetings;
      if (!saveData()) {
        state.data.meetings = previousMeetings;
        return;
      }
      state.meetingImportStatus = `Imported ${events.length} Outlook events: ${added} added, ${updated} refreshed. Existing manually added meetings were left unchanged.`;
      render();
      toast(`Calendar imported: ${added} added, ${updated} refreshed.`);
    } catch (error) {
      console.error("Could not import the Outlook calendar file.", error);
      state.meetingImportStatus = `Calendar import failed: ${error.message}`;
      render();
      toast(`Could not import calendar: ${error.message}`);
    } finally {
      document.querySelector("#calendar-import-file").value = "";
    }
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          value += character;
        }
      } else if (character === '"' && value === "") {
        quoted = true;
      } else if (character === ",") {
        row.push(value);
        value = "";
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        row.push(value);
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
        value = "";
      } else {
        value += character;
      }
    }
    if (quoted) throw new Error("The CSV file has an unclosed quoted field.");
    row.push(value);
    if (row.some((cell) => cell.trim())) rows.push(row);
    return rows;
  }

  function mergeText(current, incoming, separator) {
    const seen = new Set();
    return [current, incoming].flatMap((value) => String(value || "").split(separator)).map((value) => value.trim()).filter(Boolean).filter((value) => {
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join(separator);
  }

  async function importClientsFile(file) {
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error("The CSV does not contain any client records.");
      const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim().toLowerCase());
      const findColumn = (names) => headers.findIndex((header) => names.includes(header));
      const companyColumn = findColumn(["company", "company name", "organization"]);
      const fullNameColumn = findColumn(["full name", "client name", "client", "name"]);
      const firstNameColumn = findColumn(["first name"]);
      const lastNameColumn = findColumn(["last name", "surname"]);
      const nameColumn = companyColumn >= 0 ? companyColumn : fullNameColumn;
      if (nameColumn < 0 && firstNameColumn < 0 && lastNameColumn < 0) {
        throw new Error('A "Client Name", "Full Name", "Company", or first and last name columns are required.');
      }
      const emailColumn = findColumn(["e-mail address", "email address", "email", "e-mail 1 address", "email 1 address"]);
      const phoneColumn = findColumn(["primary phone", "phone", "phone number", "business phone", "business phone 1"]);
      const mobileColumn = findColumn(["mobile phone", "mobile"]);
      const homeColumn = findColumn(["home phone", "home phone 1"]);
      const alternateColumn = findColumn(["alternate phone", "alternate phone number", "alt phone", "business phone 2"]);
      const notesColumn = findColumn(["notes"]);
      const importedClients = rows.slice(1).map((cells) => {
        const contactName = fullNameColumn >= 0
          ? String(cells[fullNameColumn] || "").trim()
          : [firstNameColumn >= 0 ? cells[firstNameColumn] || "" : "", lastNameColumn >= 0 ? cells[lastNameColumn] || "" : ""].join(" ").trim();
        const name = String(nameColumn >= 0 && cells[nameColumn] ? cells[nameColumn] : contactName).trim();
        const phone = String(phoneColumn >= 0 && cells[phoneColumn] ? cells[phoneColumn] : mobileColumn >= 0 && cells[mobileColumn] ? cells[mobileColumn] : homeColumn >= 0 ? cells[homeColumn] || "" : "").trim();
        const alternatePhone = [
          alternateColumn >= 0 ? cells[alternateColumn] : "",
          phoneColumn >= 0 && mobileColumn >= 0 ? cells[mobileColumn] : "",
          phoneColumn >= 0 && homeColumn >= 0 ? cells[homeColumn] : ""
        ].map((value) => String(value || "").trim()).filter((value) => value && value !== phone).join(" · ");
        return {
          name,
          email: emailColumn >= 0 ? String(cells[emailColumn] || "").trim() : "",
          phone,
          alternatePhone,
          notes: mergeText(
            notesColumn >= 0 ? String(cells[notesColumn] || "").trim() : "",
            companyColumn >= 0 && contactName && contactName.toLocaleLowerCase() !== name.toLocaleLowerCase()
              ? `Contact: ${contactName}` : "",
            " | "
          )
        };
      }).filter((client) => client.name);
      if (!importedClients.length) throw new Error("No non-empty client names were found.");

      const previousClients = state.data.clients;
      const nextClients = previousClients.map((client) => ({ ...client }));
      const clientsByName = new Map(nextClients.map((client) => [client.name.trim().replace(/\s+/g, " ").toLocaleLowerCase(), client]));
      let added = 0;
      let merged = 0;
      importedClients.forEach((client) => {
        const key = client.name.replace(/\s+/g, " ").toLocaleLowerCase();
        const existing = clientsByName.get(key);
        if (!existing) {
          const record = { ...client, id: id() };
          nextClients.push(record);
          clientsByName.set(key, record);
          added += 1;
          return;
        }
        const alternateValues = [existing.alternatePhone, client.alternatePhone];
        if (existing.phone && client.phone && existing.phone.toLocaleLowerCase() !== client.phone.toLocaleLowerCase()) {
          alternateValues.push(client.phone);
        }
        existing.phone = existing.phone || client.phone;
        existing.alternatePhone = alternateValues.reduce((value, phone) => mergeText(value, phone, " · "), "");
        existing.email = existing.email || client.email;
        existing.notes = mergeText(existing.notes, client.notes, " | ");
        merged += 1;
      });

      state.data.clients = nextClients;
      if (!saveData()) {
        state.data.clients = previousClients;
        return;
      }
      render();
      toast(`Imported ${importedClients.length} clients: ${added} added, ${merged} matched or merged.`);
    } catch (error) {
      console.error("Could not import the client CSV.", error);
      toast(`Could not import clients: ${error.message}`);
    } finally {
      document.querySelector("#client-import-file").value = "";
    }
  }

  async function restoreBackup(file) {
    try {
      const imported = JSON.parse(await file.text());
      const collections = ["calls", "attendance", "meetings", "clients", "staff"];
      if (!imported || !collections.every((key) => Array.isArray(imported[key]))) throw new Error("The backup file does not contain all expected data lists.");
      if (!window.confirm("Restore this backup? It will replace the data saved in this browser.")) return;
      state.data = Object.fromEntries(collections.map((key) => [key, imported[key]]));
      const saved = saveData(true);
      render();
      if (saved) toast("Backup restored.");
    } catch (error) {
      console.error("Could not restore the Call & Time backup.", error);
      toast(`Could not restore backup: ${error.message}`);
    } finally {
      document.querySelector("#restore-file").value = "";
    }
  }

  async function mergeBackupFile(file) {
    try {
      const imported = JSON.parse(await file.text());
      const collections = ["calls", "attendance", "meetings", "clients", "staff"];
      if (!imported || !collections.every((key) => Array.isArray(imported[key]))) {
        throw new Error("The backup file does not contain all expected data lists.");
      }
      if (!window.confirm("Merge this backup with the data on this device? Existing records will be kept and matching entries will be combined.")) return;
      const previousCounts = Object.fromEntries(collections.map((key) => [key, state.data[key].length]));
      state.data = mergeDataCollections(state.data, imported);
      const saved = saveData(true);
      render();
      if (saved) {
        const added = collections.reduce((sum, key) => sum + state.data[key].length - previousCounts[key], 0);
        toast(`Backup merged. ${added} new records were added; existing records were kept.`);
      }
    } catch (error) {
      console.error("Could not merge the Call & Time backup.", error);
      toast(`Could not merge backup: ${error.message}`);
    } finally {
      document.querySelector("#merge-file").value = "";
    }
  }

  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      event.preventDefault();
      state.view = nav.dataset.nav;
      render();
      content.focus();
      return;
    }
    const filter = event.target.closest("[data-call-filter]");
    if (filter) {
      state.callFilter = filter.dataset.callFilter;
      render();
      return;
    }
    const action = event.target.closest("[data-action]");
    if (!action) return;
    const { action: name, id: recordId, kind } = action.dataset;
    if (name === "assistant-suggestion") submitAssistantQuery(action.dataset.query || "");
    else if (name === "assistant-local-retry") runLocalAssistant(action.dataset.query || "");
    else if (name === "assistant-person-choice") chooseAssistantPerson(kind, recordId);
    else if (name === "assistant-new-record") {
      if (storageFault) {
        toast("Changes are disabled until you restore a valid backup.");
      } else if (kind === "call") showCallForm();
      else if (kind === "attendance") showAttendanceForm();
      else if (kind === "meeting") showMeetingForm();
      else if (kind === "client" || kind === "staff") showDirectoryForm(kind);
    }
    else if (name === "assistant-edit-record") {
      if (kind === "call") showCallForm(recordId);
      else if (kind === "attendance") showAttendanceForm(recordId);
      else if (kind === "meeting") showMeetingForm(recordId);
    }
    else if (name === "assistant-delete-record") {
      const deleteName = kind === "attendance" ? "attendance entry" : kind;
      deleteAction(assistantCollection(kind), recordId, deleteName);
    }
    else if (name === "new-call") showCallForm();
    else if (name === "edit-call") showCallForm(recordId);
    else if (name === "delete-call") deleteAction("calls", recordId, "call");
    else if (name === "new-attendance") showAttendanceForm();
    else if (name === "edit-attendance") showAttendanceForm(recordId);
    else if (name === "delete-attendance") deleteAction("attendance", recordId, "attendance entry");
    else if (name === "new-meeting") showMeetingForm();
    else if (name === "edit-meeting") showMeetingForm(recordId);
    else if (name === "delete-meeting") deleteAction("meetings", recordId, "meeting");
    else if (name === "import-calendar") document.querySelector("#calendar-import-file").click();
    else if (name === "new-client") showDirectoryForm("client");
    else if (name === "new-staff") showDirectoryForm("staff");
    else if (name === "import-clients") document.querySelector("#client-import-file").click();
    else if (name === "directory-page") {
      state.directoryPage = Number(action.dataset.page);
      render();
    }
    else if (name === "configure-work-directory") showWorkDirectorySettings();
    else if (name === "search-work-directory") {
      state.staffSearch = document.querySelector("#staff-search")?.value || state.staffSearch;
      searchWorkDirectory();
    }
    else if (name === "add-work-staff") addWorkDirectoryStaff(recordId);
    else if (name === "delete-directory") deleteAction(kind === "client" ? "clients" : "staff", recordId, kind);
    else if (name === "close-modal") closeModal();
    else if (name === "install-app") installApp();
    else if (name === "backup") exportBackup();
    else if (name === "merge-backup") document.querySelector("#merge-file").click();
    else if (name === "cloud-connect") {
      if (cloudSession) syncCloudData().catch(() => {});
      else cloudSetupForm();
    }
    else if (name === "cloud-signout") signOutCloud();
    else if (name === "export-csv") exportCallsCsv();
    else if (name === "download-attendance-report") downloadAttendanceReport();
  });

  document.addEventListener("submit", handleFormSubmit);
  document.addEventListener("input", (event) => {
    if (event.target.id === "staff-search") {
      state.staffSearch = event.target.value;
    } else if (event.target.id === "call-search" || event.target.id === "directory-search") {
      const selection = [event.target.selectionStart, event.target.selectionEnd];
      if (event.target.id === "call-search") state.callSearch = event.target.value;
      else {
        state.directorySearch = event.target.value;
        state.directoryPage = 0;
      }
      const top = window.scrollY;
      render();
      const search = document.querySelector(`#${event.target.id}`);
      search.focus();
      search.setSelectionRange(...selection);
      window.scrollTo(0, top);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.target.id === "assistant-query" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      event.target.form?.requestSubmit();
      return;
    }
    if (event.key === "Enter" && event.target.id === "staff-search") {
      event.preventDefault();
      state.staffSearch = event.target.value;
      searchWorkDirectory();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "overview-day") {
      state.overviewDay = event.target.value || today;
      render();
    } else if (event.target.id === "field-direction") {
      const label = modalRoot.querySelector('label[for="field-staff"]');
      if (label) label.firstChild.textContent = event.target.value === "Incoming" ? "Staff requested" : "Staff requesting";
    } else if (event.target.id === "attendance-day") {
      state.attendanceDay = event.target.value || today;
      render();
    } else if (event.target.id === "report-start") {
      state.reportStart = mondayOf(event.target.value || today);
      render();
    } else if (event.target.id === "restore-file" && event.target.files?.[0]) {
      restoreBackup(event.target.files[0]);
    } else if (event.target.id === "merge-file" && event.target.files?.[0]) {
      mergeBackupFile(event.target.files[0]);
    } else if (event.target.id === "client-import-file" && event.target.files?.[0]) {
      importClientsFile(event.target.files[0]);
    } else if (event.target.id === "calendar-import-file" && event.target.files?.[0]) {
      importCalendarFile(event.target.files[0]);
    } else if (event.target.name === "client") {
      const client = state.data.clients.find((item) => item.name.toLowerCase() === event.target.value.trim().toLowerCase());
      const phone = modalRoot.querySelector('[name="phone"]');
      if (client && phone && !phone.value) phone.value = client.phone || "";
      const callForm = event.target.form;
      if (callForm?.dataset.form === "call" && !callForm.dataset.recordId && event.target.value.trim()) {
        const now = new Date();
        callForm.elements.date.value = toDateInput(now);
        callForm.elements.time.value = toTimeInput(now);
      }
    }
  });

  if (!storageFault && reconcileCompletedCallbacks()) saveData();
  setupAppInstallation();
  registerServiceWorker();
  render();
  initializeCloudSync();
  window.addEventListener("online", () => syncCloudData().catch(() => {}));
  window.addEventListener("focus", () => {
    if (cloudSession) syncCloudData().catch(() => {});
  });
})();
