(() => {
  "use strict";

  const STORAGE_KEY = "call-time-office-desk-v1";
  const WORK_ACCOUNT_KEY = "call-time-work-directory-settings-v1";
  const WORK_DIRECTORY_SCOPE = "User.ReadBasic.All";
  const today = toDateInput(new Date());
  let storageFault = false;
  let msalClientPromise;
  const state = {
    view: "overview",
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
    data: loadData()
  };

  const content = document.querySelector("#content");
  const modalRoot = document.querySelector("#modal-root");
  const sectionTitles = {
    overview: "Overview",
    calls: "Call log",
    attendance: "Attendance",
    meetings: "Meetings",
    directory: "Directory",
    reports: "Weekly report"
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

  function saveData(allowRecovery = false) {
    if (storageFault && !allowRecovery) {
      toast("Saved data could not be read, so changes were not saved. Restore a valid backup to continue.");
      return false;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    } catch (error) {
      console.error("Could not save Call & Time data.", error);
      toast("Could not save data. Check browser storage space.");
      return false;
    }
    if (allowRecovery) storageFault = false;
    return true;
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
    const end = addDays(start, 6);
    return state.data.calls.filter((call) => call.date >= start && call.date <= end);
  }

  function currentWeekAttendance(start = state.reportStart) {
    const end = addDays(start, 6);
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

  function pageHeading(eyebrow, title, description, action = "") {
    return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`;
  }

  function render() {
    document.querySelector("#current-section").textContent = sectionTitles[state.view];
    document.querySelector("#today-label").textContent = formatDate(today, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
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
      reports: renderReports
    };
    content.innerHTML = pages[state.view]();
    if (storageFault) {
      content.insertAdjacentHTML("beforeend", '<div class="notice"><strong>Saved data could not be read.</strong> Changes are disabled to protect it. Use Restore backup to load a valid backup.</div>');
    }
  }

  function renderOverview() {
    const todaysCalls = state.data.calls.filter((call) => call.date === today);
    const followUps = state.data.calls.filter((call) => /pending|callback/i.test(call.followUp || ""));
    const todaysAttendance = state.data.attendance.filter((entry) => entry.date === today);
    const todaysMeetings = state.data.meetings.filter((meeting) => meeting.date === today).sort((a, b) => a.startTime.localeCompare(b.startTime));
    const recent = sortedByNewest(state.data.calls).slice(0, 5);
    const greeting = new Intl.DateTimeFormat("en-KE", { weekday: "long" }).format(dateFromInput(today));
    return `
      ${pageHeading("YOUR WORKSPACE", `Good ${greeting}`, "A clear view of today's calls, attendance, and appointments.", `<button class="btn btn-primary" type="button" data-action="new-call"><span>＋</span> Log a call</button>`)}
      <section class="stats-grid">
        ${statCard("Calls today", todaysCalls.length, `${todaysCalls.filter((call) => call.direction === "Incoming").length} incoming · ${todaysCalls.filter((call) => call.direction === "Outgoing").length} outgoing`, "↗")}
        ${statCard("Follow-ups due", followUps.length, "Across all logged calls", "↻")}
        ${statCard("Attendance logged", todaysAttendance.length, `${todaysAttendance.filter((entry) => /present|partial/i.test(entry.status)).length} marked present or partial today`, "◷")}
        ${statCard("Meetings today", todaysMeetings.length, todaysMeetings.length ? `Next: ${formatTime(todaysMeetings[0].startTime)}` : "No meetings scheduled", "▦")}
      </section>
      <section class="dashboard-grid">
        <article class="panel">
          <header class="panel-header"><div><h2>Recent calls</h2><p>Your latest incoming and outgoing activity</p></div><button class="text-button" type="button" data-nav="calls">View call log →</button></header>
          ${recent.length ? `<div class="activity-list">${recent.map((call) => `
            <div class="activity-item"><span class="activity-mark">${call.direction === "Incoming" ? "↙" : "↗"}</span><div class="activity-copy"><div class="activity-title">${escapeHtml(call.client)}</div><div class="activity-meta">${escapeHtml(call.direction)} · ${escapeHtml(call.staff || "No staff selected")} · ${escapeHtml(call.outcome)}</div></div><span class="activity-time">${formatDate(call.date, { day: "numeric", month: "short" })} · ${formatTime(call.time)}</span></div>`).join("")}</div>` : emptyState("No calls logged yet", "Record your first call to start building today's activity.")}
        </article>
        <article class="panel">
          <header class="panel-header"><div><h2>Follow-up queue</h2><p>Callbacks and actions to complete</p></div><span class="badge badge-amber">${followUps.length} open</span></header>
          ${followUps.length ? `<div class="queue-list">${sortedByNewest(followUps).slice(0, 5).map((call) => `<div class="queue-item"><div><div class="queue-title">${escapeHtml(call.client)}</div><div class="queue-meta">${escapeHtml(call.staff || "Unassigned")} · ${formatDate(call.date)}</div></div>${badge(call.followUp)}</div>`).join("")}</div>` : emptyState("You're all caught up", "Calls marked for follow-up will appear here.")}
        </article>
      </section>
      <section class="panel section-spacer">
        <header class="panel-header"><div><h2>Today's schedule</h2><p>Appointments you've added for ${formatDate(today, { weekday: "long", day: "numeric", month: "long" })}</p></div><button class="text-button" type="button" data-nav="meetings">Manage meetings →</button></header>
        ${todaysMeetings.length ? `<div class="queue-list">${todaysMeetings.map((meeting) => `<div class="queue-item"><div><div class="queue-title">${escapeHtml(meeting.subject)}</div><div class="queue-meta">${formatTime(meeting.startTime)} – ${formatTime(meeting.endTime)} · ${escapeHtml(meeting.location || "No location")}</div></div><span class="badge">${escapeHtml(meeting.organizer || "No organizer")}</span></div>`).join("")}</div>` : emptyState("Nothing scheduled", "Add a meeting or appointment to your schedule.")}
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
    if (/leave|sick/.test(status) || /client|direct|remote|home/.test(mode)) return 8;
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
      <td><div class="table-primary">${escapeHtml(entry.staff)}</div><div class="table-secondary">${escapeHtml(entry.workMode || "—")}</div></td>
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
    const present = entries.filter((entry) => /present|partial/i.test(entry.status)).length;
    return `
      ${pageHeading("DAILY REGISTER", "Attendance", "Capture staff presence, work mode, time, and client visits.", `<button class="btn btn-primary" type="button" data-action="new-attendance"><span>＋</span> Add attendance</button>`)}
      <div class="filter-bar"><div class="filter-group"><label for="attendance-day" class="field-hint">Showing entries for</label><input id="attendance-day" class="field-control" type="date" value="${escapeHtml(state.attendanceDay)}"></div><span class="badge">${entries.length} staff entries</span></div>
      <section class="stats-grid">
        ${statCard("Present / partial", present, `For ${formatDate(state.attendanceDay)}`, "◷")}
        ${statCard("Hours worked", formatHours(hours), "Based on logged times and work mode", "⌛")}
        ${statCard("On leave / sick", entries.filter((entry) => /leave|sick/i.test(entry.status)).length, "Leave and sick leave", "＋")}
        ${statCard("Client work", entries.filter((entry) => /client/i.test(entry.workMode || "") || entry.location).length, "Entries with client work or location", "⌖")}
      </section>
      <section class="table-card"><header class="table-card-header"><div><h2>Staff attendance</h2><p>Hours are calculated from start and end times (minus a one-hour break).</p></div></header><div class="table-wrap"><table>
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

  function renderReports() {
    const calls = currentWeekCalls();
    const attendance = currentWeekAttendance();
    const incoming = calls.filter((call) => call.direction === "Incoming").length;
    const outgoing = calls.length - incoming;
    const succeeded = calls.filter((call) => /succeed/i.test(call.outcome)).length;
    const pending = calls.filter((call) => /pending|callback/i.test(call.followUp || "")).length;
    const unavailable = calls.filter((call) => /unavailable|unreachable|no answer/i.test(call.outcome)).length;
    const hours = attendance.reduce((sum, entry) => sum + attendanceHours(entry), 0);
    const expected = attendance.reduce((sum, entry) => sum + (Number(entry.expectedHours) || 8), 0);
    const days = Array.from({ length: 5 }, (_, index) => {
      const date = addDays(state.reportStart, index);
      const count = calls.filter((call) => call.date === date).length;
      return { date, count, label: formatDate(date, { weekday: "short" }) };
    });
    const maxDay = Math.max(1, ...days.map((day) => day.count));
    return `
      ${pageHeading("ACTIVITY SUMMARY", "Weekly report", "A quick view of your calls and attendance for the selected week.", `<div class="report-controls"><label for="report-start">Week starting</label><input id="report-start" class="field-control" type="date" value="${escapeHtml(state.reportStart)}"></div>`)}
      <div class="notice"><strong>${formatDate(state.reportStart)} – ${formatDate(addDays(state.reportStart, 6))}</strong> · Choose any date to view the week that contains it. For the workbook's Friday PDF email or Outlook synchronization, an external automation connection is required.</div>
      <section class="stats-grid">
        ${statCard("Total calls", calls.length, `${incoming} incoming · ${outgoing} outgoing`, "↗")}
        ${statCard("Succeeded", succeeded, calls.length ? `${Math.round(succeeded / calls.length * 100)}% of calls` : "No calls this week", "✓")}
        ${statCard("Callbacks pending", pending, "Follow-ups still open", "↻")}
        ${statCard("Hours recorded", formatHours(hours), `${formatHours(expected)} expected across ${attendance.length} attendance entries`, "◷")}
      </section>
      <section class="report-grid">
        <article class="panel"><header class="panel-header"><div><h2>Call outcomes</h2><p>${unavailable} unavailable, unreachable, or unanswered</p></div></header>
          <div class="metric-list">
            <div class="metric-row"><span>Incoming calls</span><strong>${incoming}</strong></div>
            <div class="metric-row"><span>Outgoing calls</span><strong>${outgoing}</strong></div>
            <div class="metric-row"><span>Succeeded</span><strong>${succeeded}</strong></div>
            <div class="metric-row"><span>Pending follow-ups</span><strong>${pending}</strong></div>
            <div class="metric-row"><span>Completion rate</span><strong>${calls.length ? Math.round(succeeded / calls.length * 100) : 0}%</strong></div>
          </div>
        </article>
        <article class="panel"><header class="panel-header"><div><h2>Calls by day</h2><p>Monday to Friday</p></div></header>
          <div class="day-bars">${days.map((day) => `<div class="day-bar-row"><span>${day.label}</span><div class="progress-track"><div class="progress-fill" style="width:${Math.round(day.count / maxDay * 100)}%"></div></div><strong>${day.count}</strong></div>`).join("")}</div>
        </article>
      </section>
      <section class="table-card section-spacer"><header class="table-card-header"><div><h2>Attendance summary</h2><p>Weekly hours by staff member</p></div><button class="btn btn-secondary btn-small" type="button" data-action="export-csv">Export calls CSV</button></header>
        ${attendanceReportTable(attendance)}
      </section>`;
  }

  function attendanceReportTable(entries) {
    const byStaff = new Map();
    entries.forEach((entry) => {
      const current = byStaff.get(entry.staff) || { days: 0, hours: 0, leave: 0 };
      current.days += /present|partial/i.test(entry.status) ? 1 : 0;
      current.leave += /leave|sick/i.test(entry.status) ? 1 : 0;
      current.hours += attendanceHours(entry);
      byStaff.set(entry.staff, current);
    });
    if (!byStaff.size) return emptyState("No attendance this week", "Attendance records added during the selected week will appear here.");
    return `<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Present days</th><th>Leave / sick</th><th>Hours worked</th></tr></thead><tbody>${[...byStaff.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([name, data]) => `<tr><td><strong>${escapeHtml(name)}</strong></td><td>${data.days}</td><td>${data.leave}</td><td><strong>${formatHours(data.hours)}</strong></td></tr>`).join("")}</tbody></table></div>`;
  }

  function field(label, name, value = "", options = {}) {
    const required = options.required ? " required" : "";
    const hint = options.hint ? `<span class="field-hint">${escapeHtml(options.hint)}</span>` : "";
    const optional = options.required ? "" : `<span class="optional"> · optional</span>`;
    let control = "";
    if (options.type === "select") {
      control = `<select class="field-control" id="field-${name}" name="${name}"${required}>${options.options.map((option) => `<option value="${escapeHtml(option)}" ${value === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select>`;
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

  function showCallForm(recordId = "") {
    const existing = recordId ? findRecord("calls", recordId) : null;
    const direction = existing?.direction || "Incoming";
    const currentDate = toDateInput(new Date());
    const body = `<div class="form-grid">
      ${field("Direction", "direction", direction, { type: "select", options: ["Incoming", "Outgoing"], required: true })}
      ${field("Date", "date", existing?.date || currentDate, { type: "date", required: true })}
      ${field("Time", "time", existing?.time || "", { type: "time", required: true })}
      ${field("Client", "client", existing?.client || "", { required: true, list: "clients-list", placeholder: "Client or caller name", hint: "Selecting a client automatically stamps the current date and time." })}
      ${field("Phone", "phone", existing?.phone || "", { type: "tel", placeholder: "Phone number" })}
      ${field(direction === "Incoming" ? "Staff requested" : "Staff requesting", "staff", existing?.staff || "", { list: "staff-list", placeholder: "Staff member's name" })}
      ${field("Outcome", "outcome", existing?.outcome || "Succeeded", { type: "select", options: ["Succeeded", "Engaged", "Callback Requested", "No Answer", "Unavailable", "Unreachable", "Voicemail", "Other"], required: true })}
      ${field("Follow-up status", "followUp", existing?.followUp || "Not Required", { type: "select", options: ["Not Required", "Callback Pending", "In Progress", "Completed"] })}
      ${field("Call record", "record", existing?.record || "", { wide: true, placeholder: "Brief summary of the conversation" })}
      ${field("Notes", "notes", existing?.notes || "", { type: "textarea", wide: true, placeholder: "Additional details or next steps" })}
    </div>${datalists()}`;
    openModal(existing ? "Edit call" : "Log a call", "Capture the essentials of a client conversation.", "call", body, existing ? "Save changes" : "Save call", recordId);
  }

  function showAttendanceForm(recordId = "") {
    const existing = recordId ? findRecord("attendance", recordId) : null;
    const body = `<div class="form-grid">
      ${field("Staff name", "staff", existing?.staff || "", { required: true, list: "staff-list", placeholder: "Enter staff name" })}
      ${field("Date", "date", existing?.date || state.attendanceDay, { type: "date", required: true })}
      ${field("Status", "status", existing?.status || "Present", { type: "select", options: ["Present", "Partial", "Leave", "Sick Leave", "Absent"], required: true })}
      ${field("Work mode", "workMode", existing?.workMode || "Office", { type: "select", options: ["Office", "Client Direct", "Office -> Client", "Remote", "Other"] })}
      ${field("Time in", "timeIn", existing?.timeIn || "", { type: "time" })}
      ${field("Time out", "timeOut", existing?.timeOut || "", { type: "time" })}
      ${field("Client / location", "location", existing?.location || "", { placeholder: "Client visit, office, or location" })}
      ${field("Expected hours", "expectedHours", existing?.expectedHours ?? 8, { type: "number", step: "0.25", required: true })}
      ${field("Notes", "notes", existing?.notes || "", { type: "textarea", wide: true, placeholder: "Optional attendance notes" })}
    </div>${datalists()}<p class="field-hint" style="margin:14px 0 0">Worked hours follow the workbook logic: timed shifts deduct a one-hour break; remote, client, leave, and sick entries count as 8 hours.</p>`;
    openModal(existing ? "Edit attendance" : "Add attendance", "Record one staff member's attendance for a day.", "attendance", body, existing ? "Save changes" : "Save attendance", recordId);
  }

  function showMeetingForm(recordId = "") {
    const existing = recordId ? findRecord("meetings", recordId) : null;
    const body = `<div class="form-grid">
      ${field("Date", "date", existing?.date || today, { type: "date", required: true })}
      ${field("Subject", "subject", existing?.subject || "", { required: true, placeholder: "Meeting or appointment" })}
      ${field("Start time", "startTime", existing?.startTime || "", { type: "time", required: true })}
      ${field("End time", "endTime", existing?.endTime || "", { type: "time", required: true })}
      ${field("Location", "location", existing?.location || "", { placeholder: "Room or meeting link" })}
      ${field("Organizer", "organizer", existing?.organizer || "", { list: "staff-list", placeholder: "Organizer name" })}
      ${field("Category", "category", existing?.category || "Meeting", { type: "select", options: ["Meeting", "Appointment", "Training", "Internal", "Client", "Other"] })}
      ${field("Notes", "notes", existing?.notes || "", { type: "textarea", wide: true, placeholder: "Optional details" })}
    </div>${datalists()}`;
    openModal(existing ? "Edit meeting" : "Add meeting", "Schedule an appointment in this browser.", "meeting", body, existing ? "Save changes" : "Save meeting", recordId);
  }

  function showDirectoryForm(kind) {
    const client = kind === "client";
    const body = `<div class="form-grid">
      ${field(client ? "Client name" : "Staff name", "name", "", { required: true, placeholder: client ? "Company or contact" : "Staff member" })}
      ${field(client ? "Phone" : "Email", client ? "phone" : "email", "", { type: client ? "tel" : "email", placeholder: client ? "Phone number" : "name@example.com" })}
      ${client ? field("Alternate phone", "alternatePhone", "", { type: "tel", placeholder: "Optional alternate number" }) : ""}
      ${client ? field("Email", "email", "", { type: "email", placeholder: "Optional email address" }) : ""}
      ${client ? field("Notes", "notes", "", { type: "textarea", wide: true, placeholder: "Optional client details" }) : ""}
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

  function handleFormSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    if (storageFault) {
      toast("Changes are disabled until you restore a valid backup.");
      return;
    }
    if (!form.reportValidity()) return;
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
    if (name === "new-call") showCallForm();
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
    else if (name === "backup") exportBackup();
    else if (name === "export-csv") exportCallsCsv();
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
    if (event.key === "Enter" && event.target.id === "staff-search") {
      event.preventDefault();
      state.staffSearch = event.target.value;
      searchWorkDirectory();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "field-direction") {
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

  render();
})();
