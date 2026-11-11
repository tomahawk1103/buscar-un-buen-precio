const DEFAULT_GOOGLE_SHEET_URL = "https://docs.google.com/spreadsheets/d/1_R_z-hBe1q0HGY2-co8U6MDROldoyhfwhwJwQaE3D9o/edit#gid=0";
let googleSheetUrl = DEFAULT_GOOGLE_SHEET_URL;

let marketData = null;
let currentPeriod = "3mo";
let currentFilter = "ALL";
let searchQuery = "";
let currentSort = "score_desc"; // Recomendado: Ordenar por Score de Confluencia
let currentAppMode = "BUY"; // 'BUY', 'SELL', 'JOURNAL', 'PORTFOLIO'
let currentSellAsset = null;
let currentCalcSlMode = "FIBO"; // 'FIBO' | 'ATR'
let portfolioData = null;
let currentPortfolioClosePos = null;
let chartPreviousFocus = null;
let currentPortfolioInputMeta = {};
let currentPortfolioCloseInputMeta = {};
let pendingDeleteTicker = null;
let alertSoundEnabled = localStorage.getItem("alertSoundEnabled") !== "false";
let previousAlertTickers = new Set();
let journalCurrentFilter = "ACTIVE"; // 'ACTIVE' | 'CLOSED' | 'ALL'
let currentSchedulerConfig = { enabled: true, interval_minutes: 30, smart_hours_only: false };

document.addEventListener("DOMContentLoaded", () => {
  initApp();
});

async function initApp() {
  setupEventListeners();
  setupModalEventListeners();
  loadClientConfig();
  await EuroView.init();
  await loadMarketData();
  startLivePolling();
}

async function loadClientConfig() {
  try {
    const resp = await fetch("/api/config");
    if (resp.ok) {
      const cfg = await resp.json();
      if (cfg && cfg.google_sheet_url) {
        googleSheetUrl = cfg.google_sheet_url;
      }
      if (cfg && cfg.scheduler) {
        currentSchedulerConfig = cfg.scheduler;
        if (cfg.scheduler.enabled) {
          updateSyncFreqUI(cfg.scheduler.interval_minutes);
        } else {
          updateSyncFreqUI(null);
        }
      }
    }
  } catch (e) {
    // Fallback silencioso a URL por defecto en modo estático sin servidor
  }
}

function setupEventListeners() {
  const btnSync = document.getElementById("btnSync");
  const btnOpenSheet = document.getElementById("btnOpenSheet");
  const searchInput = document.getElementById("searchInput");
  const btnClearSearch = document.getElementById("btnClearSearch");
  const sortSelect = document.getElementById("sortSelect");
  const btnResetFilters = document.getElementById("btnResetFilters");

  // Botón Google Sheet
  if (btnOpenSheet) {
    btnOpenSheet.addEventListener("click", () => {
      window.open(googleSheetUrl, "_blank");
    });
  }

  // Botón Sincronizar General
  if (btnSync) {
    btnSync.addEventListener("click", async () => {
      await syncMarketData(currentPeriod);
    });
  }

  // Botones rápidos de frecuencia de actualización automática (15 mins / 30 mins / 1 hora)
  const syncFreqBtns = document.querySelectorAll(".sync-freq-btn");
  syncFreqBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const mins = parseInt(btn.dataset.minutes, 10);
      if (mins) {
        setAutoSyncFrequency(mins);
      }
    });
  });

  // --- Selector de Modo de Operación (Compra / Venta / Diario / Cartera Real) ---
  const btnModeBuy = document.getElementById("btnModeBuy");
  const btnModeSell = document.getElementById("btnModeSell");
  const btnModeJournal = document.getElementById("btnModeJournal");
  const btnModePortfolio = document.getElementById("btnModePortfolio");

  [btnModeBuy, btnModeSell, btnModeJournal, btnModePortfolio].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        setAppMode(btn.dataset.mode);
      });
    }
  });

  const btnRefreshPortfolio = document.getElementById("btnRefreshPortfolio");
  if (btnRefreshPortfolio) {
    btnRefreshPortfolio.addEventListener("click", async () => {
      await loadAndRenderPortfolio();
      showToast("Mi Cartera Real actualizada 🔄");
    });
  }

  const btnOpenPortfolioAdd = document.getElementById("btnOpenPortfolioAdd");
  if (btnOpenPortfolioAdd) {
    btnOpenPortfolioAdd.addEventListener("click", () => {
      openPortfolioModal();
    });
  }

  const btnRefreshJournal = document.getElementById("btnRefreshJournal");
  if (btnRefreshJournal) {
    btnRefreshJournal.addEventListener("click", () => {
      loadAndRenderJournal();
      showToast("Diario de trading actualizado 🔄");
    });
  }

  // Filtros de estado del Diario: En seguimiento, Ganadas TP, En Stop, Cerradas, Todas
  const journalFilterBtns = document.querySelectorAll(".journal-filter-btn");
  journalFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      journalCurrentFilter = btn.dataset.filter || "ACTIVE";
      journalFilterBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      loadAndRenderJournal();
    });
  });

  // Clics interactivos en las tarjetas KPI del Diario para filtrar al instante
  const kpiJWinRate = document.getElementById("kpiCardJournalWinRate");
  if (kpiJWinRate) {
    kpiJWinRate.addEventListener("click", () => {
      journalCurrentFilter = "ACTIVE";
      loadAndRenderJournal();
    });
  }
  const kpiJTotal = document.getElementById("kpiCardJournalTotal");
  if (kpiJTotal) {
    kpiJTotal.addEventListener("click", () => {
      journalCurrentFilter = "ALL";
      loadAndRenderJournal();
    });
  }
  const kpiJWon = document.getElementById("kpiCardJournalWon");
  if (kpiJWon) {
    kpiJWon.addEventListener("click", () => {
      journalCurrentFilter = "WON";
      loadAndRenderJournal();
    });
  }
  const kpiJLost = document.getElementById("kpiCardJournalLost");
  if (kpiJLost) {
    kpiJLost.addEventListener("click", () => {
      journalCurrentFilter = "LOST";
      loadAndRenderJournal();
    });
  }

  // Archivar conserva el resultado; borrar exige una confirmación explícita.
  const btnClearClosedJournal = document.getElementById("btnClearClosedJournal");
  if (btnClearClosedJournal) {
    btnClearClosedJournal.addEventListener("click", () => {
      if (journalVisibleClosedIds.length) archiveJournal({ ids: journalVisibleClosedIds });
    });
  }
  const undoArchive = document.getElementById("btnUndoJournalArchive");
  if (undoArchive) undoArchive.addEventListener("click", async () => {
    if (!journalUndoIds.length) return;
    await archiveJournal({ ids: [...journalUndoIds], archived: false });
  });
  const jEntriesContainer = document.getElementById("journalEntriesContainer");
  if (jEntriesContainer) jEntriesContainer.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-journal-action]");
    if (!button || button.disabled) return;
    const id = button.dataset.id;
    const action = button.dataset.journalAction;
    if (!id) return;
    button.disabled = true;
    try {
      if (action === "delete") {
        if (!confirm("¿Borrar definitivamente esta señal? Su resultado también se eliminará de las estadísticas. Esta acción no se puede deshacer. Para conservarlo, usa Archivar.")) return;
        await journalRequest("/api/journal/remove", { id });
        journalUndoIds = journalUndoIds.filter(value => value !== id);
        document.getElementById("journalArchiveNotice").hidden = !journalUndoIds.length;
        await loadAndRenderJournal();
        showToast("Señal borrada y estadísticas recalculadas");
      } else {
        await archiveJournal({ ids: [id], archived: action === "archive" });
      }
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  });

  const btnResetJournal = document.getElementById("btnResetJournal");
  if (btnResetJournal) {
    btnResetJournal.addEventListener("click", async () => {
      if (confirm("¿Borrar las señales del Diario y sus estadísticas? Esta acción no modifica tu cartera real.")) {
        try {
          await journalRequest("/api/journal/reset", {});
          journalUndoIds = [];
          document.getElementById("journalArchiveNotice").hidden = true;
          await loadAndRenderJournal();
          showToast("Diario de trading reiniciado.");
        } catch (e) {
          showToast("Error al reiniciar diario: " + e.message);
        }
      }
    });
  }

  // Selector de Temporalidad Multi-Timeframe Instantáneo (0ms desde caché + persistencia asíncrona)
  const periodPills = document.querySelectorAll(".period-btn");
  periodPills.forEach(btn => {
    btn.addEventListener("click", async () => {
      const selectedPeriod = btn.dataset.period;
      if (selectedPeriod === currentPeriod) return;

      periodPills.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentPeriod = selectedPeriod;

      const hasPrecalculated = marketData
        && Array.isArray(marketData.data)
        && marketData.data.length > 0
        && marketData.data.every(it => it.timeframes && it.timeframes[selectedPeriod]);

      if (hasPrecalculated) {
        marketData.data.forEach(it => {
          Object.assign(it, it.timeframes[selectedPeriod]);
        });
        marketData.period = selectedPeriod;
        renderDashboard(marketData);
        showToast(`⚡ Ventana cambiada al instante a ${formatPeriodLabel(selectedPeriod)} (0 ms)`);

        // Persistir cambio de periodo en segundo plano sin bloquear la UI
        fetch("/api/period", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ period: selectedPeriod })
        }).catch(() => {});
        return;
      }

      showToast(`Cambiando temporalidad a ${formatPeriodLabel(currentPeriod)} y calculando...`);
      await syncMarketData(selectedPeriod);
    });
  });

  // Buscador reactivo
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      if (btnClearSearch) {
        btnClearSearch.style.display = searchQuery ? "flex" : "none";
      }
      renderFilteredCards();
    });
  }

  if (btnClearSearch) {
    btnClearSearch.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      searchQuery = "";
      btnClearSearch.style.display = "none";
      renderFilteredCards();
    });
  }

  // Chips de Filtro (delegación dinámica para soportar Modo Compra y Modo Venta)
  const filterChipsContainer = document.getElementById("filterChips");
  if (filterChipsContainer) {
    filterChipsContainer.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip-btn");
      if (!chip) return;
      filterChipsContainer.querySelectorAll(".chip-btn").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter || "ALL";
      renderFilteredCards();
    });
  }

  // Selector de Ordenación
  if (sortSelect) {
    sortSelect.value = currentSort;
    sortSelect.addEventListener("change", (e) => {
      currentSort = e.target.value;
      renderFilteredCards();
    });
  }

  // Botón Resetear Filtros
  if (btnResetFilters) {
    btnResetFilters.addEventListener("click", () => {
      currentFilter = "ALL";
      searchQuery = "";
      currentSort = "score_desc";

      if (searchInput) searchInput.value = "";
      if (btnClearSearch) btnClearSearch.style.display = "none";
      if (sortSelect) sortSelect.value = "score_desc";

      document.querySelectorAll("#filterChips .chip-btn").forEach(c => {
        c.classList.toggle("active", c.dataset.filter === "ALL");
      });

      renderFilteredCards();
    });
  }

  // --- Centro de Alertas y Oportunidades (Idea 5) ---
  const btnAlertsBell = document.getElementById("btnAlertsBell");
  const alertsDropdown = document.getElementById("alertsDropdown");
  const chkAlertSound = document.getElementById("chkAlertSound");
  const btnTestSound = document.getElementById("btnTestSound");
  const btnToggleBrowserNotifs = document.getElementById("btnToggleBrowserNotifs");

  if (btnAlertsBell && alertsDropdown) {
    btnAlertsBell.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = alertsDropdown.style.display !== "none";
      alertsDropdown.style.display = isVisible ? "none" : "block";
    });
  }

  if (chkAlertSound) {
    chkAlertSound.checked = alertSoundEnabled;
    chkAlertSound.addEventListener("change", (e) => {
      alertSoundEnabled = e.target.checked;
      localStorage.setItem("alertSoundEnabled", alertSoundEnabled);
      showToast(alertSoundEnabled ? "Sonido Chime activado 🔊" : "Sonido Chime silenciado 🔇");
    });
  }

  if (btnTestSound) {
    btnTestSound.addEventListener("click", (e) => {
      e.stopPropagation();
      playAlertChime();
      showToast("🔊 Sonido Chime de alerta reproducido");
    });
  }

  if (btnToggleBrowserNotifs) {
    updateBrowserNotifButtonState();
    btnToggleBrowserNotifs.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleBrowserNotifications();
    });
  }

  // Cerrar dropdown de alertas al hacer clic fuera
  document.addEventListener("click", (e) => {
    const alertsWrapper = document.querySelector(".notifications-wrapper");
    if (alertsDropdown && alertsWrapper && !alertsWrapper.contains(e.target)) {
      alertsDropdown.style.display = "none";
    }
  });
}

function setupModalEventListeners() {
  const btnOpenAddModal = document.getElementById("btnOpenAddModal");
  const btnCloseAddModal = document.getElementById("btnCloseAddModal");
  const btnCancelAddModal = document.getElementById("btnCancelAddModal");
  const btnValidateTicker = document.getElementById("btnValidateTicker");
  const addTickerInput = document.getElementById("addTickerInput");
  const btnSubmitAddAsset = document.getElementById("btnSubmitAddAsset");

  const btnCloseDeleteModal = document.getElementById("btnCloseDeleteModal");
  const btnCancelDeleteModal = document.getElementById("btnCancelDeleteModal");
  const btnConfirmDeleteAsset = document.getElementById("btnConfirmDeleteAsset");

  // Abrir Modal Añadir
  if (btnOpenAddModal) {
    btnOpenAddModal.addEventListener("click", () => {
      resetAddModal();
      const modal = document.getElementById("addAssetModal");
      if (modal) modal.style.display = "flex";
      setTimeout(() => { if (addTickerInput) addTickerInput.focus(); }, 100);
    });
  }

  // Cerrar Modal Añadir
  [btnCloseAddModal, btnCancelAddModal].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("addAssetModal");
        if (modal) modal.style.display = "none";
      });
    }
  });

  // Validar Ticker
  if (btnValidateTicker) {
    btnValidateTicker.addEventListener("click", () => {
      validateTickerAction();
    });
  }

  if (addTickerInput) {
    addTickerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        validateTickerAction();
      }
    });
  }

  // Guardar Activo
  if (btnSubmitAddAsset) {
    btnSubmitAddAsset.addEventListener("click", async () => {
      await submitAddAssetAction();
    });
  }

  // Modal Eliminar
  [btnCloseDeleteModal, btnCancelDeleteModal].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("deleteAssetModal");
        if (modal) modal.style.display = "none";
        pendingDeleteTicker = null;
      });
    }
  });

  if (btnConfirmDeleteAsset) {
    btnConfirmDeleteAsset.addEventListener("click", async () => {
      await confirmDeleteAssetAction();
    });
  }

  // Cerrar Modal Gráfico Pantalla Completa
  const btnCloseFullscreenChart = document.getElementById("btnCloseFullscreenChart");
  if (btnCloseFullscreenChart) {
    btnCloseFullscreenChart.addEventListener("click", () => {
      closeFullscreenChart();
    });
  }

  // --- Modal Telegram & Auto-Sync ---
  const btnOpenTelegramModal = document.getElementById("btnOpenTelegramModal");
  const btnCloseTelegramModal = document.getElementById("btnCloseTelegramModal");
  const btnCancelTelegramModal = document.getElementById("btnCancelTelegramModal");
  const btnTestTelegram = document.getElementById("btnTestTelegram");
  const btnSaveTelegramSettings = document.getElementById("btnSaveTelegramSettings");

  if (btnOpenTelegramModal) {
    btnOpenTelegramModal.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const alertsDropdown = document.getElementById("alertsDropdown");
      if (alertsDropdown) alertsDropdown.style.display = "none";
      openTelegramModal();
    });
  }

  [btnCloseTelegramModal, btnCancelTelegramModal].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("telegramModal");
        if (modal) modal.style.display = "none";
      });
    }
  });

  if (btnTestTelegram) {
    btnTestTelegram.addEventListener("click", async () => {
      await testTelegramAction();
    });
  }

  if (btnSaveTelegramSettings) {
    btnSaveTelegramSettings.addEventListener("click", async () => {
      await saveTelegramSettingsAction();
    });
  }

  // --- Modal Calculadora de Posición (Módulo 1) ---
  const btnCloseCalcModal = document.getElementById("btnCloseCalcModal");
  const btnCloseCalcModalFooter = document.getElementById("btnCloseCalcModalFooter");
  const btnCopyTradingPlan = document.getElementById("btnCopyTradingPlan");
  const calcRiskInput = document.getElementById("calcRiskInput");
  const riskPresetButtons = document.querySelectorAll(".btn-risk-preset");

  [btnCloseCalcModal, btnCloseCalcModalFooter].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("positionCalcModal");
        if (modal) modal.style.display = "none";
        currentCalcAsset = null;
      });
    }
  });

  if (calcRiskInput) {
    calcRiskInput.addEventListener("input", () => {
      riskPresetButtons.forEach(b => b.classList.remove("active"));
      recalcPositionPlan();
    });
  }

  riskPresetButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      riskPresetButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (calcRiskInput) {
        calcRiskInput.value = btn.dataset.amount;
        recalcPositionPlan();
      }
    });
  });

  if (btnCopyTradingPlan) {
    btnCopyTradingPlan.addEventListener("click", () => {
      copyTradingPlanToClipboard();
    });
  }

  // Selector de Método de Stop Loss (Fibonacci 78.6% vs Volatilidad 2x ATR)
  const slModeButtons = document.querySelectorAll(".btn-sl-mode");
  slModeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      slModeButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentCalcSlMode = btn.dataset.slMode || "FIBO";
      recalcPositionPlan();
    });
  });

  const btnRegisterInPortfolioFromCalc = document.getElementById("btnRegisterInPortfolioFromCalc");
  if (btnRegisterInPortfolioFromCalc) {
    btnRegisterInPortfolioFromCalc.addEventListener("click", () => {
      registerCalcPlanIntoPortfolio();
    });
  }

  // --- Modales de Mi Cartera Real (Alta/Edición y Venta/Cierre) ---
  setupPortfolioModalListeners();

  // --- Modal Venta Parcial (Módulo 2) ---
  const btnCloseSellModal = document.getElementById("btnCloseSellModal");
  const btnCloseSellModalFooter = document.getElementById("btnCloseSellModalFooter");
  const sellSharesInput = document.getElementById("sellSharesInput");
  const sellPresets = document.querySelectorAll(".btn-sell-preset");

  [btnCloseSellModal, btnCloseSellModalFooter].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("partialSellModal");
        if (modal) modal.style.display = "none";
        currentSellAsset = null;
      });
    }
  });

  if (sellSharesInput) {
    sellSharesInput.addEventListener("input", () => {
      recalcPartialSell();
    });
  }

  sellPresets.forEach(btn => {
    btn.addEventListener("click", () => {
      sellPresets.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      recalcPartialSell();
    });
  });

  // --- Modal Sentimiento de Mercado (CNN Fear & Greed) ---
  const btnSentimentInfo = document.getElementById("btnSentimentInfo");
  const kpiSentimentCard = document.getElementById("kpiSentimentCard");
  const btnCloseSentimentModal = document.getElementById("btnCloseSentimentModal");
  const btnCloseSentimentModalFooter = document.getElementById("btnCloseSentimentModalFooter");

  if (btnSentimentInfo) {
    btnSentimentInfo.addEventListener("click", (e) => {
      e.stopPropagation();
      openSentimentModal();
    });
  }

  if (kpiSentimentCard) {
    kpiSentimentCard.addEventListener("click", () => {
      openSentimentModal();
    });
  }

  [btnCloseSentimentModal, btnCloseSentimentModalFooter].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("sentimentModal");
        if (modal) modal.style.display = "none";
      });
    }
  });

  // Cerrar modales con Escape y backdrop click
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAllModals();
    }
  });

  document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        closeAllModals();
      }
    });
  });
}

function closeAllModals() {
  const addModal = document.getElementById("addAssetModal");
  const delModal = document.getElementById("deleteAssetModal");
  const tgModal = document.getElementById("telegramModal");
  const calcModal = document.getElementById("positionCalcModal");
  const sellModal = document.getElementById("partialSellModal");
  const sentimentModal = document.getElementById("sentimentModal");
  const pfModal = document.getElementById("portfolioModal");
  const pfCloseModal = document.getElementById("portfolioCloseModal");
  if (addModal) addModal.style.display = "none";
  if (delModal) delModal.style.display = "none";
  if (tgModal) tgModal.style.display = "none";
  if (calcModal) calcModal.style.display = "none";
  if (sellModal) sellModal.style.display = "none";
  if (sentimentModal) sentimentModal.style.display = "none";
  if (pfModal) pfModal.style.display = "none";
  if (pfCloseModal) pfCloseModal.style.display = "none";
  closeFullscreenChart();
  pendingDeleteTicker = null;
  currentCalcAsset = null;
  currentSellAsset = null;
  currentPortfolioClosePos = null;
}

function closeFullscreenChart() {
  const chartModal = document.getElementById("fullscreenChartModal");
  const container = document.getElementById("fullscreenChartContainer");
  if (chartModal) chartModal.style.display = "none";
  if (container) container.innerHTML = "";
  if (chartPreviousFocus?.isConnected) chartPreviousFocus.focus();
  chartPreviousFocus = null;
}

async function openTelegramModal() {
  const modal = document.getElementById("telegramModal");
  if (modal) modal.style.display = "flex";

  const tgEnabledToggle = document.getElementById("tgEnabledToggle");
  const tgBotTokenInput = document.getElementById("tgBotTokenInput");
  const tgChatIdInput = document.getElementById("tgChatIdInput");
  const syncIntervalSelect = document.getElementById("syncIntervalSelect");
  const chkSmartHours = document.getElementById("chkSmartHours");
  const marketHoursStatusTag = document.getElementById("marketHoursStatusTag");
  const chkNotifyGolden = document.getElementById("chkNotifyGolden");
  const chkNotifyConfluence = document.getElementById("chkNotifyConfluence");
  const resultBox = document.getElementById("tgTestResultBox");

  if (resultBox) {
    resultBox.style.display = "none";
    resultBox.textContent = "";
  }

  try {
    const resp = await fetch("/api/scheduler/status");
    if (resp.ok) {
      const data = await resp.json();
      const tg = data.telegram || {};
      if (tgEnabledToggle) tgEnabledToggle.checked = tg.enabled !== false;
      if (tgBotTokenInput) tgBotTokenInput.value = tg.bot_token || "";
      if (tgChatIdInput) tgChatIdInput.value = tg.chat_id || "";
      if (chkNotifyGolden) chkNotifyGolden.checked = tg.notify_on_golden_zone !== false;
      if (chkNotifyConfluence) chkNotifyConfluence.checked = tg.notify_on_high_confluence !== false;
      if (chkSmartHours) chkSmartHours.checked = data.smart_hours_only !== false;
      if (marketHoursStatusTag && data.market_hours && data.market_hours.status_label) {
        marketHoursStatusTag.textContent = `(${data.market_hours.status_label})`;
      }
      if (syncIntervalSelect) {
        if (!data.enabled) {
          syncIntervalSelect.value = "0";
          updateSyncFreqUI(null);
        } else {
          const inv = data.interval_minutes || 30;
          syncIntervalSelect.value = String(inv);
          updateSyncFreqUI(inv);
        }
      }
    }
  } catch (e) {
    console.warn("Error cargando configuración de Telegram:", e);
  }

  if (modal) modal.style.display = "flex";
}

async function testTelegramAction() {
  const tokenInput = document.getElementById("tgBotTokenInput");
  const chatInput = document.getElementById("tgChatIdInput");
  const resultBox = document.getElementById("tgTestResultBox");
  const btnTest = document.getElementById("btnTestTelegram");

  const bot_token = tokenInput ? tokenInput.value.trim() : "";
  const chat_id = chatInput ? chatInput.value.trim() : "";

  if (!bot_token || !chat_id) {
    if (resultBox) {
      resultBox.className = "tg-result-box error";
      resultBox.textContent = "Introduce el Bot Token y el Chat ID antes de realizar la prueba.";
      resultBox.style.display = "block";
    }
    return;
  }

  try {
    if (btnTest) {
      btnTest.disabled = true;
      btnTest.textContent = "Enviando...";
    }
    if (resultBox) resultBox.style.display = "none";

    const resp = await fetch("/api/telegram/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_token, chat_id })
    });

    const data = await resp.json();
    if (resultBox) {
      resultBox.style.display = "block";
      if (data.success) {
        resultBox.className = "tg-result-box success";
        resultBox.textContent = "✅ ¡Mensaje de prueba recibido en tu Telegram con éxito! Comprueba tu móvil.";
      } else {
        resultBox.className = "tg-result-box error";
        resultBox.textContent = `❌ Error de Telegram: ${data.message || "No se pudo entregar el mensaje"}`;
      }
    }
  } catch (err) {
    if (resultBox) {
      resultBox.className = "tg-result-box error";
      resultBox.textContent = `❌ Error de conexión al probar Telegram: ${err.message}`;
      resultBox.style.display = "block";
    }
  } finally {
    if (btnTest) {
      btnTest.disabled = false;
      btnTest.textContent = "📲 Probar en Móvil";
    }
  }
}

async function saveTelegramSettingsAction() {
  const tgEnabledToggle = document.getElementById("tgEnabledToggle");
  const tokenInput = document.getElementById("tgBotTokenInput");
  const chatInput = document.getElementById("tgChatIdInput");
  const syncIntervalSelect = document.getElementById("syncIntervalSelect");
  const chkSmartHours = document.getElementById("chkSmartHours");
  const chkNotifyGolden = document.getElementById("chkNotifyGolden");
  const chkNotifyConfluence = document.getElementById("chkNotifyConfluence");
  const btnSave = document.getElementById("btnSaveTelegramSettings");
  const txtSave = document.getElementById("txtSaveTelegram");

  const enabled = tgEnabledToggle ? tgEnabledToggle.checked : true;
  const bot_token = tokenInput ? tokenInput.value.trim() : "";
  const chat_id = chatInput ? chatInput.value.trim() : "";
  const interval_val = syncIntervalSelect ? parseInt(syncIntervalSelect.value, 10) : 30;
  const smart_hours_only = chkSmartHours ? chkSmartHours.checked : true;
  const notify_on_golden_zone = chkNotifyGolden ? chkNotifyGolden.checked : true;
  const notify_on_high_confluence = chkNotifyConfluence ? chkNotifyConfluence.checked : true;

  try {
    if (btnSave) btnSave.disabled = true;
    if (txtSave) txtSave.textContent = "Guardando...";

    // 1. Guardar Telegram
    const respTg = await fetch("/api/telegram/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled,
        bot_token,
        chat_id,
        min_score: 70,
        notify_on_golden_zone,
        notify_on_high_confluence
      })
    });

    // 2. Guardar Scheduler + Smart Market Hours
    const respSched = await fetch("/api/scheduler/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: interval_val > 0,
        interval_minutes: interval_val > 0 ? interval_val : 30,
        smart_hours_only
      })
    });

    if (respTg.ok && respSched.ok) {
      if (interval_val > 0) {
        updateSyncFreqUI(interval_val);
      } else {
        updateSyncFreqUI(null);
      }
      currentSchedulerConfig = {
        enabled: interval_val > 0,
        interval_minutes: interval_val > 0 ? interval_val : 30,
        smart_hours_only
      };
      const modal = document.getElementById("telegramModal");
      if (modal) modal.style.display = "none";
      const intervalMsg = interval_val > 0 ? `Auto-sync cada ${interval_val} min` : "Auto-sync pausado";
      showToast(`¡Configuración guardada! Telegram: ${enabled ? 'Activado 📲' : 'Pausado'}, ${intervalMsg}.`);
    } else {
      showToast("Hubo un problema al guardar la configuración en el servidor.");
    }
  } catch (e) {
    showToast("Error de conexión: " + e.message);
  } finally {
    if (btnSave) btnSave.disabled = false;
    if (txtSave) txtSave.textContent = "Guardar Configuración";
  }
}

function resetAddModal() {
  const addTickerInput = document.getElementById("addTickerInput");
  const addTabInput = document.getElementById("addTabInput");
  const addNameInput = document.getElementById("addNameInput");
  const previewBox = document.getElementById("tickerPreviewBox");
  const errorBox = document.getElementById("addModalError");

  if (addTickerInput) addTickerInput.value = "";
  if (addTabInput) addTabInput.value = "";
  if (addNameInput) addNameInput.value = "";
  if (previewBox) previewBox.style.display = "none";
  if (errorBox) {
    errorBox.style.display = "none";
    errorBox.textContent = "";
  }
}

async function validateTickerAction() {
  const tickerInput = document.getElementById("addTickerInput");
  const tabInput = document.getElementById("addTabInput");
  const nameInput = document.getElementById("addNameInput");
  const previewBox = document.getElementById("tickerPreviewBox");
  const errorBox = document.getElementById("addModalError");
  const btnValidate = document.getElementById("btnValidateTicker");

  const ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : "";
  if (!ticker) {
    showAddModalError("Por favor introduce un ticker (ej: TSLA, AAPL, BTC-USD).");
    return;
  }

  try {
    if (btnValidate) btnValidate.textContent = "Verificando...";
    if (errorBox) errorBox.style.display = "none";

    const resp = await fetch("/api/assets/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker })
    });

    const data = await resp.json();
    if (data.valid) {
      if (previewBox) {
        document.getElementById("previewTicker").textContent = data.ticker;
        document.getElementById("previewName").textContent = data.name || data.ticker;
        document.getElementById("previewPrice").textContent = formatPrice(data.price, data);
        previewBox.style.display = "flex";
      }

      // Autocompletar campos si están vacíos
      if (tabInput && !tabInput.value) {
        // Tomar el ticker o primera palabra corta
        let shortName = data.ticker.replace(/=F|\^/, "");
        if (data.name && data.name.length <= 8) shortName = data.name;
        tabInput.value = shortName;
      }
      if (nameInput && !nameInput.value) {
        nameInput.value = data.name || data.ticker;
      }
    } else {
      if (previewBox) previewBox.style.display = "none";
      showAddModalError(data.error || `No se pudo encontrar el ticker '${ticker}' en Yahoo Finance.`);
    }
  } catch (err) {
    showAddModalError("Error al contactar con el servidor: " + err.message);
  } finally {
    if (btnValidate) btnValidate.textContent = "Validar";
  }
}

function showAddModalError(msg) {
  const errorBox = document.getElementById("addModalError");
  if (errorBox) {
    errorBox.textContent = msg;
    errorBox.style.display = "block";
  }
}

async function submitAddAssetAction() {
  const tickerInput = document.getElementById("addTickerInput");
  const tabInput = document.getElementById("addTabInput");
  const nameInput = document.getElementById("addNameInput");
  const btnSubmit = document.getElementById("btnSubmitAddAsset");
  const submitText = document.getElementById("btnSubmitAddText");

  const ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : "";
  const tab = tabInput ? tabInput.value.trim() : "";
  const name = nameInput ? nameInput.value.trim() : (tab || ticker);

  if (!ticker) {
    showAddModalError("El ticker es obligatorio.");
    return;
  }
  if (!tab) {
    showAddModalError("El nombre corto / pestaña es obligatorio.");
    return;
  }

  try {
    if (btnSubmit) btnSubmit.disabled = true;
    if (submitText) submitText.textContent = "Guardando y calculando...";

    const resp = await fetch("/api/assets/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, tab, name })
    });

    const data = await resp.json();
    if (resp.ok) {
      marketData = EuroView.market(data);
      closeAllModals();
      renderDashboard(marketData);
      showToast(`¡Activo ${tab} (${ticker}) añadido y calculado con éxito!`);
    } else {
      showAddModalError(data.error || "No se pudo añadir el activo.");
    }
  } catch (err) {
    showAddModalError("Error de conexión al guardar: " + err.message);
  } finally {
    if (btnSubmit) btnSubmit.disabled = false;
    if (submitText) submitText.textContent = "Guardar y Calcular";
  }
}

function promptDeleteAsset(ticker, tabName) {
  pendingDeleteTicker = ticker;
  const modal = document.getElementById("deleteAssetModal");
  const elName = document.getElementById("deleteAssetName");
  const elTicker = document.getElementById("deleteAssetTicker");

  if (elName) elName.textContent = tabName || ticker;
  if (elTicker) elTicker.textContent = ticker;
  if (modal) modal.style.display = "flex";
}

async function confirmDeleteAssetAction() {
  if (!pendingDeleteTicker) return;
  const btnConfirm = document.getElementById("btnConfirmDeleteAsset");

  try {
    if (btnConfirm) {
      btnConfirm.disabled = true;
      btnConfirm.textContent = "Eliminando...";
    }

    const resp = await fetch("/api/assets/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: pendingDeleteTicker })
    });

    const data = await resp.json();
    if (resp.ok) {
      marketData = EuroView.market(data);
      const removedTicker = pendingDeleteTicker;
      closeAllModals();
      renderDashboard(marketData);
      showToast(`Activo ${removedTicker} eliminado de seguimiento.`);
    } else {
      showToast(data.error || "Error al eliminar el activo.");
    }
  } catch (err) {
    showToast("Error de conexión: " + err.message);
  } finally {
    if (btnConfirm) {
      btnConfirm.disabled = false;
      btnConfirm.textContent = "Eliminar";
    }
  }
}

async function loadMarketData() {
  try {
    let response;
    try {
      response = await fetch("/api/data");
    } catch {
      response = await fetch("latest_data.json");
    }

    if (!response.ok) {
      response = await fetch("latest_data.json");
    }

    if (response.ok) {
      marketData = EuroView.market(await response.json());
      if (marketData && marketData.period) {
        currentPeriod = marketData.period;
        updatePeriodPillsUI(currentPeriod);
      }
      renderDashboard(marketData);
    } else {
      console.warn("No se pudo cargar latest_data.json directamente");
    }
  } catch (err) {
    console.error("Error al cargar datos:", err);
  }
}

function startLivePolling() {
  // Sondeo suave cada 20 segundos para reflejar actualizaciones del auto-scheduler en segundo plano
  setInterval(async () => {
    try {
      const resp = await fetch("/api/data");
      if (resp.ok) {
        await EuroView.init();
        const fresh = EuroView.market(await resp.json());
        if (fresh && fresh.timestamp && (!marketData || fresh.timestamp !== marketData.timestamp || fresh.__eur_fx !== marketData.__eur_fx)) {
          console.log(`[Live Polling] 🔄 Nuevos datos detectados (${fresh.timestamp}). Actualizando dashboard...`);
          marketData = fresh;
          if (marketData.period) {
            currentPeriod = marketData.period;
            updatePeriodPillsUI(currentPeriod);
          }
          renderDashboard(marketData);
        } else if (currentAppMode === "JOURNAL") {
          // El Diario puede terminar de actualizarse después de publicar los precios.
          await loadAndRenderJournal();
        }
      }
    } catch (e) {
      // Manejar caídas temporales de red silenciosamente
    }
  }, 20000);
}

function updateSyncFreqUI(mins) {
  const target = mins ? parseInt(mins, 10) : null;
  const btns = document.querySelectorAll(".sync-freq-btn");
  btns.forEach(btn => {
    const m = parseInt(btn.dataset.minutes, 10);
    const isActive = target !== null && m === target;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

async function setAutoSyncFrequency(mins) {
  const m = parseInt(mins, 10);
  if (!m || m <= 0) return;

  // Actualización visual inmediata de los botones
  updateSyncFreqUI(m);

  const smartHours = (currentSchedulerConfig && typeof currentSchedulerConfig.smart_hours_only === "boolean")
    ? currentSchedulerConfig.smart_hours_only
    : false;

  try {
    const resp = await fetch("/api/scheduler/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        interval_minutes: m,
        smart_hours_only: smartHours
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data && data.scheduler) {
        currentSchedulerConfig = data.scheduler;
      }
      const label = m === 60 ? "1 hora" : `${m} mins`;
      showToast(`⏱️ Frecuencia automática ajustada a cada ${label}`);

      // Sincronizar select del modal si está presente
      const syncIntervalSelect = document.getElementById("syncIntervalSelect");
      if (syncIntervalSelect) {
        syncIntervalSelect.value = String(m);
      }
    } else {
      showToast("No se pudo guardar la frecuencia de actualización.");
    }
  } catch (err) {
    showToast("Error de conexión al cambiar la frecuencia.");
  }
}

async function syncMarketData(periodToSync) {
  const btnSync = document.getElementById("btnSync");
  const btnText = document.getElementById("btnSyncText");
  const syncIcon = document.querySelector(".sync-icon");
  const periodButtons = document.querySelectorAll(".period-btn");

  const period = periodToSync || currentPeriod || "3mo";

  try {
    if (btnSync) btnSync.disabled = true;
    if (btnText) btnText.textContent = `Actualizando (${period})...`;
    if (syncIcon) syncIcon.classList.add("rotating");
    periodButtons.forEach(b => b.disabled = true);

    const resp = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period: period })
    });

    if (resp.ok) {
      marketData = EuroView.market(await resp.json());
      currentPeriod = marketData.period || period;
      updatePeriodPillsUI(currentPeriod);
      renderDashboard(marketData);
      showToast(`¡Mercado y Confluencia Técnica actualizados! Ventana: ${formatPeriodLabel(currentPeriod)}`);
    } else {
      showToast("Para sincronizar en vivo, ejecuta 'python app.py' o 'Actualizar_Precios.bat'");
    }
  } catch (err) {
    console.warn("Error en sincronización vía API:", err);
    await loadMarketData();
    showToast("Datos locales recargados.");
  } finally {
    if (btnSync) btnSync.disabled = false;
    if (btnText) btnText.textContent = "Actualizar Precios";
    if (syncIcon) syncIcon.classList.remove("rotating");
    periodButtons.forEach(b => b.disabled = false);
  }
}

function updatePeriodPillsUI(period) {
  const periodButtons = document.querySelectorAll(".period-btn");
  periodButtons.forEach(b => {
    b.classList.toggle("active", b.dataset.period === period);
  });
}

function formatPeriodLabel(p) {
  switch (p) {
    case "1mo": return "1 Mes";
    case "3mo": return "3 Meses";
    case "6mo": return "6 Meses";
    case "1y": return "1 Año";
    default: return p;
  }
}

function summarizePortfolioBadge(items) {
  if (!items || items.length === 0) return "Sin Activos";
  let hasUS = false;
  let hasEU = false;
  let hasCrypto = false;
  let hasCommodities = false;
  let hasIndices = false;
  let hasForex = false;

  items.forEach(it => {
    const t = (it.ticker || "").toUpperCase();
    if (t.endsWith("-USD") || t.endsWith("-EUR")) hasCrypto = true;
    else if (t.endsWith("=F")) hasCommodities = true;
    else if (t.startsWith("^")) hasIndices = true;
    else if (t.endsWith("=X")) hasForex = true;
    else if (t.includes(".")) hasEU = true;
    else hasUS = true;
  });

  const tags = [];
  if (hasUS) tags.push("USA");
  if (hasEU) tags.push("Europa");
  if (hasCrypto) tags.push("Cripto");
  if (hasCommodities) tags.push("Materias");
  if (hasIndices) tags.push("Índices");
  if (hasForex) tags.push("Forex");

  if (tags.length === 0) return "Multi-Activo";
  if (tags.length <= 2) return tags.join(" & ");
  if (tags.length === 3) return `${tags[0]}, ${tags[1]} & ${tags[2]}`;
  return "Cartera Multi-Activo";
}

function renderDashboard(data) {
  if (!data || !data.data) return;

  const items = data.data;

  // 1. Render KPIs Generales (100% dinámicos según los activos configurados)
  document.getElementById("kpiTotal").textContent = items.length;
  const elTotalBadge = document.getElementById("kpiTotalBadge");
  const elTotalNames = document.getElementById("kpiTotalNames");
  if (elTotalBadge) {
    elTotalBadge.textContent = summarizePortfolioBadge(items);
  }
  if (elTotalNames) {
    if (items.length === 0) {
      elTotalNames.textContent = "Añade tu primer ticker con + Añadir Activo";
    } else if (items.length <= 8) {
      elTotalNames.textContent = items.map(i => i.tab).join(", ");
    } else {
      elTotalNames.textContent = `${items.slice(0, 7).map(i => i.tab).join(", ")} +${items.length - 7} más`;
    }
  }
  document.getElementById("kpiLastUpdate").textContent = (data.timestamp || "--:--:--") + ((data.failed_tickers || []).length ? ` ⚠️ Sin actualizar: ${data.failed_tickers.join(", ")}` : "");
  document.getElementById("kpiPeriod").textContent = `Ventana de cálculo: ${formatPeriodLabel(data.period || currentPeriod)}`;

  let buyCount = 0;
  let buyNames = [];
  let maxDrop = 0;
  let maxDropName = "--";
  let topScore = 0;
  let topScoreName = "--";
  let topScoreDesc = "Fibonacci + RSI + SMA200";

  items.forEach(item => {
    if (item.current_price <= item.fib_levels["50.0%"]) {
      buyCount++;
      buyNames.push(item.tab);
    }
    if (item.drop_pct > maxDrop) {
      maxDrop = item.drop_pct;
      maxDropName = item.tab;
    }
    const sc = item.score || 0;
    if (sc > topScore) {
      topScore = sc;
      topScoreName = item.tab;
      topScoreDesc = `${item.confluence_rating || "Alta Confluencia"} (RSI ${item.rsi ? item.rsi.toFixed(1) : "--"})`;
    }
  });

  document.getElementById("kpiBuyCount").textContent = buyCount;
  document.getElementById("kpiBuyNames").textContent = buyCount > 0 ? buyNames.join(", ") : "Ninguno en zona 50%+";
  document.getElementById("kpiMaxDrop").textContent = `-${maxDrop.toFixed(1)}%`;
  document.getElementById("kpiMaxDropName").textContent = maxDropName;

  const elTopScore = document.getElementById("kpiTopScore");
  const elTopScoreName = document.getElementById("kpiTopScoreName");
  const elTopScoreDesc = document.getElementById("kpiTopScoreDesc");

  if (elTopScore) elTopScore.textContent = `${topScore}/100`;
  if (elTopScoreName) elTopScoreName.textContent = topScoreName;
  if (elTopScoreDesc) elTopScoreDesc.textContent = topScoreDesc;

  // 1b. Render KPI Sentimiento de Mercado (CNN Fear & Greed)
  renderMarketSentiment(data.market_sentiment);

  // 2. Actualizar contadores en los chips de filtro
  updateFilterBadges(items);

  // 3. Actualizar Radar de Alertas y Oportunidades (Idea 5)
  updateAlertsCenter(items);

  // 3b. Actualizar contador de Alertas en Modo Venta
  let sellAlerts = 0;
  items.forEach(it => {
    if (it.sell_mgmt && (it.sell_mgmt.sell_score >= 35 || (it.rsi || 50) >= 62 || it.sell_mgmt.dist_to_high_pct <= 4.0)) {
      sellAlerts++;
    }
  });
  const elSellPill = document.getElementById("sellAlertPill");
  if (elSellPill) {
    elSellPill.textContent = `${sellAlerts} ${sellAlerts === 1 ? 'alerta' : 'alertas'}`;
    elSellPill.style.background = sellAlerts > 0 ? 'rgba(244, 63, 94, 0.3)' : 'rgba(255, 255, 255, 0.08)';
    elSellPill.style.color = sellAlerts > 0 ? '#fda4af' : '#a89f91';
  }

  // 3c. Cargar métricas del diario y de Mi Cartera Real en segundo plano
  const elMarketStatus = document.getElementById("marketStatus");
  if (elMarketStatus && data.market_hours && data.market_hours.status_label) {
    elMarketStatus.title = data.market_hours.status_label;
  }
  loadAndRenderJournal();
  loadAndRenderPortfolio();

  // 4. Renderizar tarjetas filtradas y ordenadas
  renderFilteredCards();
}

function hasInstitutionalLiquiditySignal(item) {
  const liq = item && item.liquidity;
  if (!liq) return false;
  const nearPoc = typeof liq.poc_dist_pct === "number" && Math.abs(liq.poc_dist_pct) <= 2.5;
  const fib38 = item.fib_levels && item.fib_levels["38.2%"];
  const hasFibPocInPullback = Boolean(
    liq.fib_poc_confluence &&
    liq.fib_poc_confluence.has_confluence &&
    typeof fib38 === "number" &&
    item.current_price <= fib38
  );
  return Boolean(
    liq.has_sweep ||
    liq.has_absorption ||
    nearPoc ||
    hasFibPocInPullback ||
    (liq.liquidity_score || 0) >= 68
  );
}

function updateFilterBadges(items) {
  let countAll = items.length;
  let countConfluence = 0;
  let countBuy = 0;
  let countGolden = 0;
  let countLiquidity = 0;
  let countWatch = 0;

  let countSellStrong = 0;
  let countSellAlert = 0;
  let countOverbought = 0;
  let countHoldAccum = 0;

  items.forEach(it => {
    if ((it.score || 0) >= 70) countConfluence++;
    if (it.current_price <= it.fib_levels["50.0%"]) countBuy++;
    if (it.current_price <= it.fib_levels["61.8%"]) countGolden++;
    if (hasInstitutionalLiquiditySignal(it)) countLiquidity++;
    if (it.status_code === "WATCH_38" || it.status_code === "WATCH_23") countWatch++;

    const sm = it.sell_mgmt || {};
    const sScore = sm.sell_score || 0;
    const sCode = sm.sell_status_code || "ACCUMULATE";
    if (sCode === "STRONG_SELL" || sScore >= 70) countSellStrong++;
    if (sCode === "STRONG_SELL" || sCode === "PARTIAL_SELL" || sScore >= 35 || (sm.dist_to_high_pct !== undefined && sm.dist_to_high_pct <= 4.0)) {
      countSellAlert++;
    }
    if ((it.rsi || 50) >= 62) countOverbought++;
    if (sCode === "HOLD" || sCode === "ACCUMULATE") countHoldAccum++;
  });

  const setCount = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setCount("countAll", countAll);
  setCount("countConfluence", countConfluence);
  setCount("countBuy", countBuy);
  setCount("countGolden", countGolden);
  setCount("countLiquidity", countLiquidity);
  setCount("countWatch", countWatch);

  setCount("countSellStrong", countSellStrong);
  setCount("countSellAlert", countSellAlert);
  setCount("countOverbought", countOverbought);
  setCount("countHoldAccum", countHoldAccum);
}

function updateAlertsCenter(items) {
  items = items.filter(item => !item.is_stale);
  const alertsBadge = document.getElementById("alertsBadge");
  const alertsSummaryCount = document.getElementById("alertsSummaryCount");
  const alertsList = document.getElementById("alertsList");
  const btnBell = document.getElementById("btnAlertsBell");

  if (!alertsList) return;

  // Filtrar activos que tengan alguna condición relevante de oportunidad
  const alertItems = [];

  items.forEach(item => {
    const isGolden = item.current_price <= item.fib_levels["61.8%"];
    const isConfluence = (item.score || 0) >= 70;
    const isBuy50 = item.current_price <= item.fib_levels["50.0%"];
    const liq = item.liquidity || null;
    const isSweepSignal = Boolean(liq && liq.has_sweep && item.current_price <= item.fib_levels["38.2%"]);

    if (isGolden || isConfluence || isBuy50 || isSweepSignal) {
      let priorityClass = "priority-buy";
      let priorityBadge = "🟢 Zona de Compra (50%)";
      let priorityWeight = 1;

      if (isGolden && isConfluence) {
        priorityClass = "priority-confluence";
        priorityBadge = "🔥 Confluencia Áurea";
        priorityWeight = 3;
      } else if (isGolden) {
        priorityClass = "priority-golden";
        priorityBadge = "🏆 Zona Áurea (61.8%)";
        priorityWeight = 2.5;
      } else if (isConfluence) {
        priorityClass = "priority-confluence";
        priorityBadge = "🔥 Confluencia Alta";
        priorityWeight = 2;
      } else if (isSweepSignal) {
        priorityClass = "priority-confluence";
        priorityBadge = "🧲 Barrido de Stops (Spring SMC)";
        priorityWeight = 1.8;
      }

      alertItems.push({
        item,
        priorityClass,
        priorityBadge,
        priorityWeight,
        score: item.score || 0,
        isGolden,
        isConfluence
      });
    }
  });

  // Ordenar por prioridad descendente y luego por score
  alertItems.sort((a, b) => {
    if (b.priorityWeight !== a.priorityWeight) {
      return b.priorityWeight - a.priorityWeight;
    }
    return b.score - a.score;
  });

  const totalAlerts = alertItems.length;

  // Actualizar Badge en la Campana
  if (alertsBadge) {
    if (totalAlerts > 0) {
      alertsBadge.textContent = totalAlerts;
      alertsBadge.style.display = "flex";
      if (btnBell) btnBell.classList.add("has-alerts");
    } else {
      alertsBadge.style.display = "none";
      if (btnBell) btnBell.classList.remove("has-alerts");
    }
  }

  if (alertsSummaryCount) {
    alertsSummaryCount.textContent = `${totalAlerts} ${totalAlerts === 1 ? 'oportunidad activa' : 'oportunidades activas'}`;
  }

  // Renderizar contenido de la lista
  alertsList.innerHTML = "";

  if (totalAlerts === 0) {
    alertsList.innerHTML = `
      <div class="alerts-empty-state">
        <div class="alerts-empty-icon">🛡️</div>
        <div class="alerts-empty-title">Sin alertas en este momento</div>
        <div class="alerts-empty-desc">Ningún activo se encuentra en Zona Áurea o Confluencia Alta para este periodo.</div>
      </div>
    `;
    return;
  }

  // Detectar si hay nuevos activos para sonido y notificación de escritorio
  const currentTickers = new Set(alertItems.map(a => a.item.ticker));
  let hasNewAlerts = false;
  currentTickers.forEach(t => {
    if (!previousAlertTickers.has(t)) {
      hasNewAlerts = true;
    }
  });

  // Sonar chime si hay nuevas oportunidades detectadas
  if (hasNewAlerts && alertSoundEnabled) {
    playAlertChime();
  }

  // Notificación nativa de escritorio
  if (hasNewAlerts && Notification.permission === "granted" && previousAlertTickers.size > 0) {
    const topAlert = alertItems[0];
    sendDesktopNotification(
      `🎯 Oportunidad: ${topAlert.item.tab} (${topAlert.item.ticker})`,
      `${topAlert.priorityBadge} a ${formatPrice(topAlert.item.current_price, topAlert.item)}. Score Técnico: ${topAlert.score}/100.`
    );
  }

  previousAlertTickers = currentTickers;

  // Renderizar tarjetas de cada oportunidad
  alertItems.forEach(({ item, priorityClass, priorityBadge, score }) => {
    const cardItem = document.createElement("div");
    cardItem.className = `alert-item ${priorityClass}`;

    let scoreClass = "score-low";
    if (score >= 80) scoreClass = "score-fire";
    else if (score >= 65) scoreClass = "score-high";

    const earnWarnHtml = (item.earnings && item.earnings.warning_level === "IMMINENT" && item.earnings.label)
      ? `<div style="margin-top:4px; color:#fbbf24; font-size:0.74rem; font-weight:600;">${escapeHtml(item.earnings.label)}</div>`
      : "";

    const liq = item.liquidity || null;
    let liqAlertHtml = "";
    if (liq) {
      if (liq.has_sweep && liq.sweep_label) {
        liqAlertHtml = `<div style="margin-top:3px; color:#9bb8cc; font-size:0.73rem; font-weight:600;">${escapeHtml(liq.sweep_label)}</div>`;
      } else if (liq.has_absorption && liq.absorption_label) {
        liqAlertHtml = `<div style="margin-top:3px; color:#5cc092; font-size:0.73rem; font-weight:600;">${escapeHtml(liq.absorption_label)}</div>`;
      } else if (liq.poc_price) {
        liqAlertHtml = `<div style="margin-top:3px; color:#a89f91; font-size:0.72rem;">🏦 Muro POC: <strong>${formatPrice(liq.poc_price, item)}</strong> • RVOL ${(liq.rvol || 1).toFixed(2)}x</div>`;
      }
    }

    cardItem.innerHTML = `
      <div class="alert-item-header">
        <div class="alert-item-title">
          <span>${item.tab}</span>
          <span class="alert-item-ticker">${item.ticker}</span>
        </div>
        <span class="alert-item-score ${scoreClass}">Score: ${score}/100</span>
      </div>
      <div class="alert-item-desc">
        <strong>${priorityBadge}</strong>: Cotizando a <strong>${formatPrice(item.current_price, item)}</strong> 
        (-${item.drop_pct.toFixed(1)}% desde máx). RSI: <strong>${item.rsi ? item.rsi.toFixed(1) : '--'}</strong>.
        ${liqAlertHtml}
        ${earnWarnHtml}
      </div>
      <div class="alert-item-actions">
        <button class="btn-alert-nav" data-ticker="${item.ticker}" title="Ver tarjeta de ${item.tab}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 16 16 12 12 8"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Ver Ficha
        </button>
        <button class="btn-alert-chart" data-ticker="${item.ticker}" data-tab="${item.tab}" title="Abrir gráfico avanzado">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          Gráfico ⛶
        </button>
      </div>
    `;

    // Botón para hacer scroll suave hasta la tarjeta del activo y resaltarla
    const btnNav = cardItem.querySelector(".btn-alert-nav");
    if (btnNav) {
      btnNav.addEventListener("click", () => {
        const dropdown = document.getElementById("alertsDropdown");
        if (dropdown) dropdown.style.display = "none";
        highlightCard(item.ticker);
      });
    }

    // Botón para abrir el gráfico fullscreen directamente
    const btnChart = cardItem.querySelector(".btn-alert-chart");
    if (btnChart) {
      btnChart.addEventListener("click", () => {
        const dropdown = document.getElementById("alertsDropdown");
        if (dropdown) dropdown.style.display = "none";
        openFullscreenChart(item.ticker, item.tab);
      });
    }

    alertsList.appendChild(cardItem);
  });
}

function highlightCard(ticker) {
  const cardId = `card-${ticker.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const el = document.getElementById(cardId);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("card-highlight");
    void el.offsetWidth; // forzar reflow para reiniciar animación
    el.classList.add("card-highlight");
    setTimeout(() => {
      el.classList.remove("card-highlight");
    }, 2000);
  }
}

function playAlertChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    // Tono armónico dual (D5 587.33Hz y A5 880Hz)
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now);
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12);

    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(880, now);
    osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.18);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.6);
    osc2.stop(now + 0.6);
  } catch (e) {
    console.warn("Audio chime playback blocked or not supported:", e);
  }
}

function updateBrowserNotifButtonState() {
  const btn = document.getElementById("btnToggleBrowserNotifs");
  const txt = document.getElementById("txtBrowserNotif");
  if (!btn || !txt) return;

  if (!("Notification" in window)) {
    txt.textContent = "Avisos no soportados";
    btn.disabled = true;
    return;
  }

  if (Notification.permission === "granted") {
    btn.classList.add("active");
    txt.textContent = "Avisos de escritorio: ACTIVADOS ✓";
  } else if (Notification.permission === "denied") {
    btn.classList.remove("active");
    txt.textContent = "Avisos bloqueados por navegador";
  } else {
    btn.classList.remove("active");
    txt.textContent = "Activar avisos de escritorio";
  }
}

async function toggleBrowserNotifications() {
  if (!("Notification" in window)) {
    showToast("Tu navegador no soporta notificaciones de escritorio.");
    return;
  }

  if (Notification.permission === "granted") {
    showToast("Las notificaciones de escritorio ya están activadas.");
    updateBrowserNotifButtonState();
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      showToast("¡Avisos de escritorio activados! Recibirás alertas en segundo plano.");
      sendDesktopNotification(
        "Radar de Oportunidades Activado 🎯",
        "Te avisaremos cuando un valor alcance la Zona Áurea o Confluencia Alta."
      );
    } else {
      showToast("Permiso de notificaciones denegado en el navegador.");
    }
  } catch (err) {
    console.warn("Error requesting notification permission:", err);
  }
  updateBrowserNotifButtonState();
}

function sendDesktopNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
        body,
        icon: "https://www.tradingview.com/static/images/favicon.ico"
      });
    } catch (e) {
      console.warn("Notification error:", e);
    }
  }
}

function renderFilteredCards() {
  if (currentAppMode === "JOURNAL" || currentAppMode === "PORTFOLIO") return;
  if (!marketData || !marketData.data) return;

  const rawItems = [...marketData.data];

  // Aplicar Filtro de búsqueda
  let filtered = rawItems.filter(item => {
    if (!searchQuery) return true;
    const q = searchQuery;
    const matchTab = item.tab && item.tab.toLowerCase().includes(q);
    const matchTicker = item.ticker && item.ticker.toLowerCase().includes(q);
    const matchName = item.name && item.name.toLowerCase().includes(q);
    return matchTab || matchTicker || matchName;
  });

  // Aplicar Filtro de Categoría (adaptativo según Modo Compra / Modo Venta)
  filtered = filtered.filter(item => {
    if (currentFilter === "ALL") return true;

    // Filtros Modo Compra (BUY)
    if (currentFilter === "CONFLUENCE") {
      return (item.score || 0) >= 70;
    }
    if (currentFilter === "BUY_ZONE") {
      return item.current_price <= item.fib_levels["50.0%"];
    }
    if (currentFilter === "GOLDEN") {
      return item.current_price <= item.fib_levels["61.8%"];
    }
    if (currentFilter === "LIQUIDITY") {
      return hasInstitutionalLiquiditySignal(item);
    }
    if (currentFilter === "WATCH") {
      return item.status_code === "WATCH_38" || item.status_code === "WATCH_23";
    }

    // Filtros Modo Venta (SELL)
    const sm = item.sell_mgmt || {};
    const sScore = sm.sell_score || 0;
    const sCode = sm.sell_status_code || "ACCUMULATE";
    if (currentFilter === "SELL_STRONG") {
      return sCode === "STRONG_SELL" || sScore >= 70;
    }
    if (currentFilter === "SELL_ALERT") {
      return sCode === "STRONG_SELL" || sCode === "PARTIAL_SELL" || sScore >= 35 || (sm.dist_to_high_pct !== undefined && sm.dist_to_high_pct <= 4.0);
    }
    if (currentFilter === "OVERBOUGHT") {
      return (item.rsi || 50) >= 62;
    }
    if (currentFilter === "HOLD_ACCUM") {
      return sCode === "HOLD" || sCode === "ACCUMULATE";
    }
    return true;
  });

  // Aplicar Ordenación
  filtered.sort((a, b) => {
    if (currentAppMode === "SELL") {
      const smA = a.sell_mgmt || {};
      const smB = b.sell_mgmt || {};
      switch (currentSort) {
        case "score_desc":
          return (smB.sell_score || 0) - (smA.sell_score || 0);
        case "gain_desc":
          return (smB.gain_from_low_pct || 0) - (smA.gain_from_low_pct || 0);
        case "rsi_desc":
          return (b.rsi || 50) - (a.rsi || 50);
        case "high_dist_asc":
          return (smA.dist_to_high_pct ?? 100) - (smB.dist_to_high_pct ?? 100);
        case "price_desc":
          return b.current_price - a.current_price;
        case "price_asc":
          return a.current_price - b.current_price;
        case "name_asc":
          return a.tab.localeCompare(b.tab);
        default:
          return (smB.sell_score || 0) - (smA.sell_score || 0);
      }
    }
    switch (currentSort) {
      case "score_desc":
        return (b.score || 0) - (a.score || 0);
      case "liquidity_desc":
        return ((b.liquidity && b.liquidity.liquidity_score) || 0) - ((a.liquidity && a.liquidity.liquidity_score) || 0);
      case "rvol_desc":
        return ((b.liquidity && b.liquidity.rvol) || 0) - ((a.liquidity && a.liquidity.rvol) || 0);
      case "drop_desc":
        return b.drop_pct - a.drop_pct;
      case "drop_asc":
        return a.drop_pct - b.drop_pct;
      case "rsi_asc":
        return (a.rsi || 50) - (b.rsi || 50);
      case "price_asc":
        return a.current_price - b.current_price;
      case "price_desc":
        return b.current_price - a.current_price;
      case "name_asc":
        return a.tab.localeCompare(b.tab);
      default:
        return (b.score || 0) - (a.score || 0);
    }
  });

  const grid = document.getElementById("assetsGrid");
  const emptyState = document.getElementById("emptyState");
  const emptyStateMsg = document.getElementById("emptyStateMsg");

  grid.innerHTML = "";

  if (filtered.length === 0) {
    grid.style.display = "none";
    if (emptyState) {
      emptyState.style.display = "block";
      if (searchQuery) {
        emptyStateMsg.textContent = `No hay ningún activo que coincida con "${searchQuery}".`;
      } else {
        emptyStateMsg.textContent = "No hay ningún activo en la categoría de filtro seleccionada.";
      }
    }
  } else {
    grid.style.display = "grid";
    if (emptyState) emptyState.style.display = "none";

    filtered.forEach((item, idx) => {
      const card = createAssetCard(item);
      card.style.animationDelay = `${idx * 0.04}s`;
      grid.appendChild(card);
    });
  }
}

function renderStabilizationContext(item) {
  const context = item.stabilization;
  if (!context) return '';
  const old = item.is_stale || context.state === 'STALE';
  const range = context.support != null && context.resistance != null
    ? `<span>Franja de ${context.window_minutes} min: ${formatPrice(context.support, item)} — ${formatPrice(context.resistance, item)}</span>` : '';
  return `<details class="stabilization-context" data-stabilization="${escapeHtml(context.state)}"><summary>🧭 ${old ? 'Lectura anterior · ' : ''}${escapeHtml(context.label)}</summary>${range}<p>${escapeHtml(context.summary)}</p><small>${context.as_of ? `Lectura: ${escapeHtml(context.as_of)} · ` : ''}Es contexto, no una señal de entrada.</small></details>`;
}

function createAssetCard(item) {
  const card = document.createElement("article");
  card.className = "asset-card";
  card.id = `card-${item.ticker.replace(/[^a-zA-Z0-9]/g, '_')}`;
  card.dataset.ticker = item.ticker;

  const isInBuyZone = item.current_price <= item.fib_levels["50.0%"];
  if (isInBuyZone) {
    card.classList.add("in-buy-zone");
  }

  // Determinar posición del precio en el rango 0% a 100%
  const range = item.max - item.min;
  let pctPos = 0;
  if (range > 0) {
    pctPos = ((item.current_price - item.min) / range) * 100;
    pctPos = Math.max(0, Math.min(100, pctPos));
  }

  // Determinar clase de señal
  let signalClass = "signal-watch";
  if (item.status_code === "BUY_GOLDEN" || item.status_code === "STRONG_BUY") {
    signalClass = "signal-buy-golden";
  } else if (item.status_code === "BUY_50") {
    signalClass = "signal-buy-50";
  } else if (item.status_code === "EXPENSIVE") {
    signalClass = "signal-expensive";
  }

  // TradingView Symbol mapping
  const tvSymbol = getTradingViewSymbol(item.ticker);

  // Indicadores Técnicos
  const score = item.score || 0;
  let scoreBadgeClass = "score-low";
  let scoreLabel = "Neutral";
  if (score >= 80) {
    scoreBadgeClass = "score-fire";
    scoreLabel = "🔥 Confluencia";
  } else if (score >= 65) {
    scoreBadgeClass = "score-high";
    scoreLabel = "🟢 Alta Prob.";
  } else if (score >= 45) {
    scoreBadgeClass = "score-moderate";
    scoreLabel = "🟡 Moderada";
  }

  const rsi = typeof item.rsi === "number" ? item.rsi : 50;
  let rsiClass = "neutral";
  let rsiLabel = "Neutral";
  if (rsi <= 30) {
    rsiClass = "oversold";
    rsiLabel = "Sobreventa";
  } else if (rsi <= 40) {
    rsiClass = "mild";
    rsiLabel = "Descuento";
  } else if (rsi > 60) {
    rsiClass = "overbought";
    rsiLabel = "Sobrecompra";
  }

  const isAboveSma = item.is_above_sma !== undefined ? item.is_above_sma : (item.sma_dist_pct >= 0);
  const smaDist = typeof item.sma_dist_pct === "number" ? item.sma_dist_pct : 0;
  const smaClass = isAboveSma ? "bullish" : "bearish";
  const smaSign = smaDist >= 0 ? "+" : "";
  const smaLabel = isAboveSma ? `${smaSign}${smaDist.toFixed(1)}% 🐂 Alcista` : `${smaSign}${smaDist.toFixed(1)}% 🐻 Bajista`;

  // Módulo 1: Gestión de Riesgo (Risk Management)
  const risk = item.risk_mgmt || {
    entry_price: item.current_price,
    stop_loss: item.fib_levels["78.6%"] * 0.98,
    risk_pct: 5.0,
    take_profit_1: item.fib_levels["38.2%"],
    reward_1_pct: 10.0,
    rr_ratio_1: 1.5,
    take_profit_2: item.max,
    reward_2_pct: 20.0,
    rr_ratio_2: 2.5,
    rr_rating: "🟢 Favorable (R:R > 1:2)",
    rr_code: "FAVORABLE"
  };

  let rrBadgeClass = "rr-favorable";
  if (risk.rr_code === "EXCELLENT") rrBadgeClass = "rr-excellent";
  else if (risk.rr_code === "ACCEPTABLE") rrBadgeClass = "rr-acceptable";
  else if (risk.rr_code === "TIGHT") rrBadgeClass = "rr-tight";

  // Cronología del Impulso (Mínimo -> Máximo vs Cuchillo Cayendo)
  const swingType = item.swing_type || "NEUTRAL";
  const swingLabel = item.swing_label || "";
  let swingClass = "swing-neutral";
  if (swingType === "BULLISH_PULLBACK") swingClass = "swing-bullish";
  else if (swingType === "BOTTOM_REBOUND") swingClass = "swing-rebound";
  else if (swingType === "FALLING_KNIFE") swingClass = "swing-falling";

  const swingTooltip = (item.low_date && item.high_date)
    ? `Suelo registrado: ${item.low_date} | Techo registrado: ${item.high_date}`
    : "Cronología entre el mínimo y el máximo de la ventana seleccionada";
  const swingBadgeHtml = swingLabel
    ? `<div class="swing-row"><span class="swing-pill ${swingClass}" title="${swingTooltip}">${swingLabel}</span></div>`
    : "";

  // Píldoras de Inteligencia Bloque 3 + Motor de Liquidez Institucional
  const liq = item.liquidity || null;
  const intelBadges = [];
  if (item.earnings && item.earnings.has_earnings && (item.earnings.warning_level === "IMMINENT" || item.earnings.warning_level === "UPCOMING")) {
    const eCls = item.earnings.warning_level === "IMMINENT" ? "earnings-imminent" : "earnings-upcoming";
    const epsHint = (item.earnings.eps_avg !== null && item.earnings.eps_avg !== undefined)
      ? ` | BPA estimado: ${item.earnings.eps_avg}`
      : "";
    intelBadges.push(
      `<span class="earnings-pill ${eCls}" title="Próxima presentación de resultados: ${item.earnings.next_date}${epsHint}">${item.earnings.label}</span>`
    );
  }
  if (item.best_cluster && item.best_cluster.label) {
    const cCls = item.best_cluster.is_active ? "cluster-active" : "cluster-nearby";
    const rawMembers = item.best_cluster.members_detail || item.best_cluster.members || [];
    const cTooltip = rawMembers
      .map(m => typeof m === "string" ? m : `${m.period_label || (m.period || "").toUpperCase()} ${m.level} (${formatPrice(m.price, item)})`)
      .join(" + ");
    intelBadges.push(
      `<span class="cluster-pill ${cCls}" title="Confluencia Multi-Timeframe: ${cTooltip}">${item.best_cluster.label}</span>`
    );
  }
  if (liq && liq.has_sweep && liq.sweep_label) {
    intelBadges.push(
      `<span class="liq-pill liq-sweep" title="Barrido de Stops / Spring SMC (${escapeHtml(liq.sweep_date || '')}): perforó soporte previo y cerró por encima capturando liquidez">${escapeHtml(liq.sweep_label)}</span>`
    );
  }
  if (liq && liq.has_absorption && liq.absorption_label) {
    intelBadges.push(
      `<span class="liq-pill liq-absorption" title="Absorción Institucional detectada (RVOL pico 3 sesiones: ${(liq.peak_rvol_3d || liq.rvol || 1).toFixed(2)}x)">${escapeHtml(liq.absorption_label)}</span>`
    );
  } else if (liq && liq.fib_poc_confluence && liq.fib_poc_confluence.has_confluence) {
    intelBadges.push(
      `<span class="liq-pill liq-poc" title="Confluencia Fibonacci + Volume Profile (${liq.profile_type === 'TPO' ? 'TPO' : 'Volumen Real'}) | Área de Valor 70%: ${formatPrice(liq.val_price, item)} – ${formatPrice(liq.vah_price, item)}">${escapeHtml(liq.fib_poc_confluence.label)}</span>`
    );
  }
  const intelPillsHtml = intelBadges.length > 0
    ? `<div class="card-intel-pills">${intelBadges.join("")}</div>`
    : "";

  const pocPinHtml = (liq && typeof liq.poc_pct_pos === "number")
    ? `<div class="range-poc-pin" style="left: ${Math.max(2, Math.min(98, liq.poc_pct_pos))}%;" title="🏦 Muro POC (Mayor Liquidez): ${formatPrice(liq.poc_price, item)} | Área de Valor 70% (VAL–VAH): ${formatPrice(liq.val_price, item)} – ${formatPrice(liq.vah_price, item)}"></div>`
    : "";

  let liquidityCardHtml = "";
  if (liq && liq.poc_price) {
    const liqScore = liq.liquidity_score || 0;
    let liqScoreCls = "liq-score-normal";
    if (liqScore >= 72 || liq.has_sweep) liqScoreCls = "liq-score-prime";
    else if (liqScore >= 52 || liq.has_absorption) liqScoreCls = "liq-score-high";

    let verdictCls = "verdict-normal";
    if (liq.liquidity_code === "SWEEP_ABSORPTION" || liq.liquidity_code === "SWEEP") verdictCls = "verdict-sweep";
    else if (liq.liquidity_code === "ABSORPTION" || liq.liquidity_code === "AT_POC" || liq.liquidity_code === "FIB_POC") verdictCls = "verdict-bullish";
    else if (liq.liquidity_code === "EQL_MAGNET") verdictCls = "verdict-warn";
    else if (liq.liquidity_code === "BELOW_VAL") verdictCls = "verdict-discount";

    const pocSign = (liq.poc_dist_pct || 0) >= 0 ? "+" : "";
    const pocSub = `${pocSign}${(liq.poc_dist_pct || 0).toFixed(1)}% vs actual${liq.profile_type === "TPO" ? " • TPO" : ""}`;
    const rvolMain = liq.has_real_volume ? `${(liq.rvol || 0).toFixed(2)}x` : "TPO";
    const rvolCls = (liq.rvol_status === "CLIMAX" || liq.rvol_status === "HIGH")
      ? "val-liq-cyan"
      : (liq.rvol_status === "LOW" ? "val-liq-muted" : "val-liq-neutral");
    const sslDist = Math.abs(liq.ssl_dist_pct || 0).toFixed(1);
    const sslTag = liq.is_equal_lows ? "🧲 Doble Suelo" : "Swing Low";

    liquidityCardHtml = `
    <!-- Panel Motor de Liquidez Institucional (Volume Profile POC + RVOL + Piscinas SSL) -->
    <div class="liquidity-engine-card">
      <div class="liq-header-row">
        <div class="liq-title">
          <span>🏦 Liquidez Institucional (SMC)</span>
        </div>
        <span class="liq-score-badge ${liqScoreCls}" title="Score de Liquidez Institucional (POC + RVOL/Absorción + Piscina Stops)">Liq: ${liqScore}/100</span>
      </div>

      <div class="liq-metrics-row">
        <div class="liq-col" title="Point of Control (${liq.profile_type === 'TPO' ? 'TPO' : 'Volume Profile'}): ${formatPrice(liq.poc_price, item)} | Área de Valor 70% (VAL–VAH): ${formatPrice(liq.val_price, item)} – ${formatPrice(liq.vah_price, item)}">
          <span class="liq-label">🏦 Muro POC</span>
          <span class="liq-val val-liq-gold">${formatPrice(liq.poc_price, item)}</span>
          <span class="liq-sub">${pocSub}</span>
        </div>
        <div class="liq-col" title="Volumen Relativo frente a media de 20 sesiones (Pico últimas 3 sesiones: ${(liq.peak_rvol_3d || liq.rvol || 0).toFixed(2)}x)">
          <span class="liq-label">🐋 RVOL (20d)</span>
          <span class="liq-val ${rvolCls}">${rvolMain}</span>
          <span class="liq-sub">${escapeHtml(liq.rvol_label || "Normal")}</span>
        </div>
        <div class="liq-col" title="${escapeHtml(liq.ssl_type_label || 'Piscina de Stops')} en ${formatPrice(liq.ssl_pool_price, item)}${risk.ssl_stop_loss ? ` | Stop protegido bajo piscina SSL: ${formatPrice(risk.ssl_stop_loss, item)}` : ''}">
          <span class="liq-label">🧲 Piscina SSL</span>
          <span class="liq-val val-liq-cyan">${formatPrice(liq.ssl_pool_price, item)}</span>
          <span class="liq-sub">-${sslDist}% • ${sslTag}</span>
        </div>
      </div>

      <div class="liq-verdict-strip ${verdictCls}">
        <span>${escapeHtml(liq.liquidity_verdict || "💧 Flujo de Liquidez Normal")}</span>
      </div>
    </div>`;
  }

  const atrTooltipExtra = risk.atr_stop_loss
    ? ` | Stop Volatilidad 2x ATR(14): ${formatPrice(risk.atr_stop_loss, item)} (-${(risk.atr_risk_pct || 0).toFixed(1)}%)`
    : "";
  const sslTooltipExtra = risk.ssl_stop_loss
    ? ` | Stop Bajo Piscina Liquidez (SSL): ${formatPrice(risk.ssl_stop_loss, item)} (-${(risk.ssl_risk_pct || 0).toFixed(1)}%)`
    : "";

  card.innerHTML = `
    <div class="card-header-row">
      <div class="asset-identity">
        <h2 class="asset-name">${item.tab}</h2>
        <div class="asset-ticker-row">
          <span class="asset-ticker">${item.ticker}</span>
          <span class="asset-company">${item.name}</span>
        </div>
      </div>
      <div style="display: flex; align-items: flex-start; gap: 8px;">
        <div class="asset-price-box">
          <div class="asset-current-price">${formatPrice(item.current_price, item)}</div>${item.is_stale ? `<div class="earnings-pill">⚠️ Último precio válido: ${escapeHtml(item.last_success_at || "fecha desconocida")}</div>` : ""}
          <span class="asset-drop-pill drop-negative">-${item.drop_pct.toFixed(1)}% desde máx</span>
        </div>
        <button class="btn-card-delete" title="Dejar de seguir ${item.tab} (${item.ticker})">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    </div>

    ${renderStabilizationContext(item)}
    ${intelPillsHtml}

    <!-- Banner de Señal Principal -->
    <div class="signal-banner ${signalClass}">
      <span>${item.signal}</span>
      <span style="font-size: 0.75rem; opacity: 0.85;">${item.zone_desc}</span>
    </div>

    <!-- Panel de Confluencia Técnica (Score, RSI, SMA 200) -->
    <div class="tech-metrics-grid">
      <div class="tech-metric-item">
        <span class="tech-metric-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          Score Calidad
        </span>
        <div class="tech-metric-value">
          <span class="tech-score-val">${score}/100</span>
          <span class="tech-score-badge ${scoreBadgeClass}">${scoreLabel}</span>
        </div>
      </div>

      <div class="tech-metric-item">
        <span class="tech-metric-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          RSI (14 días)
        </span>
        <div class="tech-metric-value">
          <span class="rsi-pill ${rsiClass}" title="RSI: ${rsi.toFixed(1)} (${rsiLabel})">
            <span class="rsi-dot"></span>
            ${rsi.toFixed(1)} <span style="font-size: 0.72rem; font-weight: 500; opacity: 0.85;">(${rsiLabel})</span>
          </span>
        </div>
      </div>

      <div class="tech-metric-item">
        <span class="tech-metric-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
          Tendencia SMA 200
        </span>
        <div class="tech-metric-value">
          <span class="sma-pill ${smaClass}" title="Media de 200 días: ${formatPrice(item.sma_200, item)}">
            ${smaLabel}
          </span>
        </div>
      </div>
    </div>

    <!-- Termómetro visual del Rango (Mínimo a Máximo) y Cronología -->
    <div class="range-gauge-container">
      ${swingBadgeHtml}
      <div class="range-label-row">
        <span>Suelo (Mín): <strong>${formatPrice(item.min, item)}</strong></span>
        <span>Techo (Máx): <strong>${formatPrice(item.max, item)}</strong></span>
      </div>
      <div class="range-track">
        <div class="range-fill" style="width: ${pctPos}%;"></div>
        ${pocPinHtml}
        <div class="range-pin" style="left: ${pctPos}%;" title="Precio actual: ${formatPrice(item.current_price, item)}"></div>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: #756c60; margin-top: 4px;">
        <span>Descuento Máximo</span>
        <span>${liq && liq.poc_price ? `🏦 POC: ${formatPrice(liq.poc_price, item)}` : `Rango: ${formatPrice(item.range, item)}`}</span>
        <span>Resistencia</span>
      </div>
    </div>

    <!-- Escalera de Retrocesos de Fibonacci + Densidad Volume Profile -->
    <div class="fib-ladder">
      ${renderFibRow("23.6%", item.fib_levels["23.6%"], item.current_price, "🟡", false, item)}
      ${renderFibRow("38.2%", item.fib_levels["38.2%"], item.current_price, "🟡", false, item)}
      ${renderFibRow("50.0%", item.fib_levels["50.0%"], item.current_price, "🟢", false, item)}
      ${renderFibRow("61.8%", item.fib_levels["61.8%"], item.current_price, "🏆", true, item)}
      ${renderFibRow("78.6%", item.fib_levels["78.6%"], item.current_price, "💎", false, item)}
    </div>

    ${liquidityCardHtml}

    <!-- Panel de Gestión de Riesgo (Módulo 1) -->
    <div class="risk-management-card">
      <div class="risk-header-row">
        <div class="risk-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Gestión de Riesgo & R:R</span>
        </div>
        <span class="rr-badge ${rrBadgeClass}">${risk.rr_rating || '🟢 Favorable'}</span>
      </div>

      <div class="risk-metrics-row">
        <div class="risk-col stop-loss-col" title="Stop Loss estructural bajo 78.6%${atrTooltipExtra}${sslTooltipExtra}">
          <span class="risk-label">🛡️ Stop Loss</span>
          <span class="risk-val val-danger">${formatPrice(risk.stop_loss, item)}</span>
          <span class="risk-sub">-${(risk.risk_pct || 0).toFixed(1)}%${item.atr_pct ? ` • ATR ${item.atr_pct.toFixed(1)}%` : " riesgo"}</span>
        </div>
        <div class="risk-col tp1-col" title="Take Profit 1 en resistencia 38.2%">
          <span class="risk-label">🎯 TP 1 (38.2%)</span>
          <span class="risk-val val-success">${formatPrice(risk.take_profit_1, item)}</span>
          <span class="risk-sub">+${(risk.reward_1_pct || 0).toFixed(1)}% | 1:${risk.rr_ratio_1 || 1}</span>
        </div>
        <div class="risk-col tp2-col" title="Take Profit 2 en re-test de máximos">
          <span class="risk-label">🚀 TP 2 (Máx)</span>
          <span class="risk-val val-rocket">${formatPrice(risk.take_profit_2, item)}</span>
          <span class="risk-sub">+${(risk.reward_2_pct || 0).toFixed(1)}% | 1:${risk.rr_ratio_2 || 2}${risk.ssl_rr_ratio_2 && Math.abs(risk.ssl_rr_ratio_2 - (risk.rr_ratio_2 || 0)) > 0.1 ? ` <span class="badge-ssl-rr" title="Ratio R:R 1:${risk.ssl_rr_ratio_2} con Stop ceñido bajo piscina SSL (${formatPrice(risk.ssl_stop_loss, item)})" style="color:#38bdf8; font-weight:600; cursor:help;">(1:${risk.ssl_rr_ratio_2} SSL)</span>` : ""}</span>
        </div>
      </div>

      <div class="risk-actions-row">
        <button class="btn-calc-position" data-ticker="${item.ticker}" title="Calcular posición con Stop Fibonacci, Volatilidad 2x ATR o Bajo Piscina Liquidez (SSL)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/></svg>
          🧮 Calcular Posición
        </button>
        <button class="btn-card-portfolio" data-ticker="${item.ticker}" title="Registrar compra de ${item.tab} en Mi Cartera Real">
          💼 Cartera
        </button>
      </div>
    </div>

    <!-- Toolbar de Gráficos -->
    <div class="card-chart-toolbar">
      <button class="btn-toggle-chart" data-ticker="${item.ticker}" title="Ver u ocultar mini gráfico de ${item.tab}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Mini Gráfico
      </button>
      <button class="btn-fullscreen-trigger" data-ticker="${item.ticker}" data-tab="${item.tab}" title="Abrir gráfico avanzado a pantalla completa">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        Expandir ⛶
      </button>
    </div>

    <!-- Drawer Desplegable con Mini-Gráfico TradingView -->
    <div class="card-chart-drawer" data-ticker="${item.ticker}" style="display: none;">
      <div class="chart-drawer-header">
        <span class="chart-drawer-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Tendencia TradingView (${currentPeriod.toUpperCase()})
        </span>
        <button class="btn-fullscreen-chart" data-ticker="${item.ticker}" data-tab="${item.tab}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          Pantalla Completa
        </button>
      </div>
      <div class="chart-widget-wrapper">
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; min-height: 200px; color: #a89f91; font-size: 0.82rem;">
          Cargando gráfico interactivo de ${item.tab}...
        </div>
      </div>
    </div>

    <div class="card-actions">
      <a class="tv-link" href="https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol)}/" target="_blank" rel="noopener noreferrer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        TradingView Oficial
      </a>
      <span style="font-size: 0.75rem; color: #a89f91;">Ref: Pestaña <strong>"${item.tab}"</strong></span>
    </div>
  `;

  // Modo Venta: Reemplazar contenido con la tarjeta de Salida / Toma de Beneficios
  if (currentAppMode === "SELL") {
    const sell = item.sell_mgmt || {
      sell_score: 20,
      sell_signal: "🟢 SIN PRESIÓN DE VENTA",
      sell_action: "Activo en zona baja o media; no es momento de vender.",
      sell_status_code: "ACCUMULATE",
      gain_from_low_pct: 5.0,
      dist_to_high_pct: 15.0,
      ext_127: item.max * 1.05,
      ext_161: item.max * 1.15,
      dist_to_ext127_pct: 8.0,
      dist_to_ext161_pct: 18.0,
      trailing_stop: item.current_price * 0.945,
      trailing_stop_pct: 5.5
    };

    let sellBadgeClass = "badge-accumulate";
    if (sell.sell_status_code === "STRONG_SELL") sellBadgeClass = "badge-strong";
    else if (sell.sell_status_code === "PARTIAL_SELL") sellBadgeClass = "badge-partial";
    else if (sell.sell_status_code === "HOLD") sellBadgeClass = "badge-hold";

    card.innerHTML = `
      <div class="card-header-row">
        <div class="asset-identity">
          <h2 class="asset-name">${item.tab}</h2>
          <div class="asset-ticker-row">
            <span class="asset-ticker">${item.ticker}</span>
            <span class="asset-company">${item.name}</span>
          </div>
        </div>
        <div style="display: flex; align-items: flex-start; gap: 8px;">
          <div class="asset-price-box">
            <div class="asset-current-price">${formatPrice(item.current_price, item)}</div>${item.is_stale ? `<div class="earnings-pill">⚠️ Último precio válido: ${escapeHtml(item.last_success_at || "fecha desconocida")}</div>` : ""}
            <span class="asset-drop-pill drop-positive" style="color: #4ade80;">+${sell.gain_from_low_pct.toFixed(1)}% desde mín</span>
          </div>
          <button class="btn-card-delete" title="Dejar de seguir ${item.tab} (${item.ticker})">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </div>

      ${intelPillsHtml}

      <!-- Banner de Señal de Venta -->
      ${renderStabilizationContext(item)}
      <div class="signal-banner" style="background: rgba(225, 29, 72, 0.15); border: 1px solid rgba(225, 29, 72, 0.35); color: #fda4af;">
        <span>${sell.sell_signal}</span>
        <span style="font-size: 0.75rem; opacity: 0.85;">${sell.dist_to_high_pct <= 2 ? 'En Resistencia Máxima' : `A ${sell.dist_to_high_pct.toFixed(1)}% del techo`}</span>
      </div>

      <!-- Panel de Métricas de Sobrecompra -->
      <div class="tech-metrics-grid">
        <div class="tech-metric-item">
          <span class="tech-metric-label">Presión de Venta</span>
          <div class="tech-metric-value">
            <span class="tech-score-val" style="color: #fb7185;">${sell.sell_score}/100</span>
            <span class="sell-badge ${sellBadgeClass}" style="font-size: 0.68rem;">${sell.sell_status_code === 'STRONG_SELL' ? '🔥 Extrema' : (sell.sell_status_code === 'PARTIAL_SELL' ? '🟠 Alerta' : '🟡 Moderada')}</span>
          </div>
        </div>

        <div class="tech-metric-item">
          <span class="tech-metric-label">RSI (14 días)</span>
          <div class="tech-metric-value">
            <span class="rsi-pill ${rsiClass}">
              <span class="rsi-dot"></span>
              ${rsi.toFixed(1)} <span style="font-size: 0.72rem; opacity: 0.85;">(${rsiLabel})</span>
            </span>
          </div>
        </div>

        <div class="tech-metric-item">
          <span class="tech-metric-label">Distancia Techo</span>
          <div class="tech-metric-value">
            <span style="font-weight: 700; font-family: var(--font-mono); color: #f4efe6;">-${sell.dist_to_high_pct.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      <!-- Termómetro visual del Rango (Mínimo a Máximo) y Cronología -->
      <div class="range-gauge-container">
        ${swingBadgeHtml}
        <div class="range-label-row">
          <span>Suelo (Mín): <strong>${formatPrice(item.min, item)}</strong></span>
          <span>Techo (Máx): <strong>${formatPrice(item.max, item)}</strong></span>
        </div>
        <div class="range-track">
          <div class="range-fill" style="width: ${pctPos}%;"></div>
          ${pocPinHtml}
          <div class="range-pin" style="left: ${pctPos}%;" title="Precio actual: ${formatPrice(item.current_price, item)}"></div>
        </div>
      </div>

      <!-- Módulo de Venta y Extensiones de Fibonacci -->
      <div class="sell-management-card">
        <div class="sell-mgmt-header">
          <span class="sell-mgmt-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4M12 16V9"/></svg>
            Extensiones Fibonacci & Trailing Stop
          </span>
          <span class="sell-badge ${sellBadgeClass}">${sell.sell_status_code}</span>
        </div>

        <div class="sell-levels-grid">
          <div class="sell-level-item">
            <span class="sell-level-label">Extensión 127.2%</span>
            <span class="sell-level-price" style="color: #e0a84e;">${formatPrice(sell.ext_127, item)}</span>
            <span class="sell-level-sub">a ${sell.dist_to_ext127_pct >= 0 ? '+' : ''}${sell.dist_to_ext127_pct.toFixed(1)}%</span>
          </div>
          <div class="sell-level-item">
            <span class="sell-level-label">Extensión 161.8%</span>
            <span class="sell-level-price" style="color: #c084fc;">${formatPrice(sell.ext_161, item)}</span>
            <span class="sell-level-sub">a ${sell.dist_to_ext161_pct >= 0 ? '+' : ''}${sell.dist_to_ext161_pct.toFixed(1)}%</span>
          </div>
          <div class="sell-level-item">
            <span class="sell-level-label">Trailing Stop (-5.5%)</span>
            <span class="sell-level-price" style="color: #fb7185;">${formatPrice(sell.trailing_stop, item)}</span>
            <span class="sell-level-sub">Protector ganancias</span>
          </div>
        </div>

        <div class="sell-action-note">
          💡 <strong>Estrategia recomendada:</strong> ${sell.sell_action}
        </div>

        <div class="risk-actions-row">
          <button class="btn-calc-sell" data-ticker="${item.ticker}" title="Simular venta parcial de beneficios">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4M12 16V9"/></svg>
            🧮 Simular Venta Parcial
          </button>
          <button class="btn-card-portfolio" data-ticker="${item.ticker}" title="Gestionar ${item.tab} en Mi Cartera Real">
            💼 Cartera
          </button>
        </div>
      </div>

      <!-- Toolbar de Gráficos -->
      <div class="card-chart-toolbar">
        <button class="btn-toggle-chart" data-ticker="${item.ticker}" title="Ver u ocultar mini gráfico">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Mini Gráfico
        </button>
        <button class="btn-fullscreen-trigger" data-ticker="${item.ticker}" data-tab="${item.tab}" title="Expandir gráfico en pantalla completa">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          Expandir ⛶
        </button>
      </div>

      <div class="card-chart-drawer" data-ticker="${item.ticker}" style="display: none;">
        <div class="chart-drawer-header">
          <span class="chart-drawer-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            Tendencia TradingView (${currentPeriod.toUpperCase()})
          </span>
          <button class="btn-fullscreen-chart" data-ticker="${item.ticker}" data-tab="${item.tab}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            Pantalla Completa
          </button>
        </div>
        <div class="chart-widget-wrapper">
          <div style="display: flex; align-items: center; justify-content: center; height: 100%; min-height: 200px; color: #a89f91; font-size: 0.82rem;">
            Cargando gráfico interactivo de ${item.tab}...
          </div>
        </div>
      </div>

      <div class="card-actions">
        <a class="tv-link" href="https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol)}/" target="_blank" rel="noopener noreferrer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          TradingView Oficial
        </a>
        <span style="font-size: 0.75rem; color: #a89f91;">Ref: Pestaña <strong>"${item.tab}"</strong></span>
      </div>
    `;

    const btnCalcSell = card.querySelector(".btn-calc-sell");
    if (btnCalcSell) {
      btnCalcSell.addEventListener("click", (e) => {
        e.stopPropagation();
        openPartialSellModal(item);
      });
    }

    attachCardCommonEvents(card, item);
    return card;
  }

  // Asignar evento a la calculadora de posición (Modo Compra)
  const btnCalc = card.querySelector(".btn-calc-position");
  if (btnCalc) {
    btnCalc.addEventListener("click", (e) => {
      e.stopPropagation();
      openPositionCalculator(item);
    });
  }

  attachCardCommonEvents(card, item);
  return card;
}

function attachCardCommonEvents(card, item) {
  addBusinessButton(card, item);
  // Asignar evento al botón eliminar
  const btnDelete = card.querySelector(".btn-card-delete");
  if (btnDelete) {
    btnDelete.addEventListener("click", (e) => {
      e.stopPropagation();
      promptDeleteAsset(item.ticker, item.tab);
    });
  }

  // Asignar evento al botón mini-gráfico (toggle accordion drawer)
  const btnToggleChart = card.querySelector(".btn-toggle-chart");
  if (btnToggleChart) {
    btnToggleChart.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMiniChart(item.ticker, card, item.tab);
    });
  }

  // Asignar eventos a los botones de pantalla completa
  const btnFullscreenTriggers = card.querySelectorAll(".btn-fullscreen-trigger, .btn-fullscreen-chart");
  btnFullscreenTriggers.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFullscreenChart(item.ticker, item.tab);
    });
  });

  // Asignar evento al botón rápido "💼 Cartera"
  const btnPortfolio = card.querySelector(".btn-card-portfolio");
  if (btnPortfolio) {
    btnPortfolio.addEventListener("click", (e) => {
      e.stopPropagation();
      openPortfolioModalForAsset(item);
    });
  }

  // Clic para copiar precio exacto en filas de Fibonacci
  card.querySelectorAll(".fib-row[data-copy-price]").forEach(row => {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const rawPrice = row.dataset.copyPrice;
      const lvlName = row.dataset.fibLevel || "Fibonacci";
      if (!rawPrice) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(rawPrice).then(() => {
          showToast(`📋 Precio ${lvlName} de ${item.tab} copiado: ${rawPrice}`);
        }).catch(() => {});
      }
    });
  });
}

function toggleMiniChart(ticker, cardElement, tabName) {
  const drawer = cardElement.querySelector(`.card-chart-drawer[data-ticker="${ticker}"]`);
  const toggleBtn = cardElement.querySelector(`.btn-toggle-chart[data-ticker="${ticker}"]`);
  if (!drawer) return;

  const isHidden = drawer.style.display === "none";
  if (isHidden) {
    drawer.style.display = "block";
    if (toggleBtn) {
      toggleBtn.classList.add("active");
      toggleBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
        Ocultar Gráfico
      `;
    }

    const widgetWrapper = drawer.querySelector(".chart-widget-wrapper");
    if (widgetWrapper && !widgetWrapper.dataset.loaded) {
      widgetWrapper.dataset.loaded = "true";
      loadTradingViewMiniWidget(widgetWrapper, ticker);
    }
  } else {
    drawer.style.display = "none";
    if (toggleBtn) {
      toggleBtn.classList.remove("active");
      toggleBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Mini Gráfico
      `;
    }
  }
}

function loadTradingViewMiniWidget(containerEl, ticker) {
  const item = marketData?.data?.find(asset => asset.ticker === ticker);
  EuroView.chart(containerEl, item, currentPeriod);
}

function openFullscreenChart(ticker, tabName) {
  const item = marketData?.data?.find(asset => asset.ticker === ticker);
  const title = document.getElementById("fullscreenChartTitle");
  const subtitle = document.getElementById("fullscreenChartSubtitle");
  const container = document.getElementById("fullscreenChartContainer");
  const modal = document.getElementById("fullscreenChartModal");
  chartPreviousFocus = document.activeElement;
  if (modal) modal.style.display = 'flex';
  if (modal && !modal.dataset.focusBound) {
    modal.dataset.focusBound = 'true';
    modal.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll('button, a[href]')].filter(node => !node.disabled);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
  }
  if (title) title.textContent = `${tabName || ticker} (${ticker}) — Gráfico en ${item?.currency || 'su divisa'}`;
  if (subtitle) subtitle.textContent = "Misma divisa y cambio de referencia que las tarjetas. En TradingView externo puedes seleccionar EUR en la escala de precios.";
  if (container) {
    EuroView.chart(container, item, currentPeriod, true);
    const link = document.createElement('a');
    link.className = 'btn btn-secondary';
    link.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(getTradingViewSymbol(ticker))}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Herramientas de TradingView ↗ (selecciona EUR en su escala)';
    container.append(link);
  }
  document.getElementById('btnCloseFullscreenChart')?.focus();
}


function getTradingViewSymbol(ticker) {
  if (!ticker) return "SP:SPX";
  const t = ticker.toUpperCase().trim();

  const specialMap = {
    "GC=F": "COMEX:GC1!",
    "CL=F": "NYMEX:CL1!",
    "SI=F": "COMEX:SI1!",
    "^GSPC": "SP:SPX",
    "^DJI": "DJ:DJI",
    "^IXIC": "NASDAQ:IXIC",
    "BTC-USD": "COINBASE:BTCUSD",
    "ETH-USD": "COINBASE:ETHUSD",
    "SOL-USD": "COINBASE:SOLUSD",
    "EURUSD=X": "FX:EURUSD",
    "AMD": "NASDAQ:AMD",
    "NVDA": "NASDAQ:NVDA",
    "TSLA": "NASDAQ:TSLA",
    "META": "NASDAQ:META",
    "CEG": "NASDAQ:CEG",
    "AAPL": "NASDAQ:AAPL",
    "MSFT": "NASDAQ:MSFT",
    "AMZN": "NASDAQ:AMZN",
    "GOOGL": "NASDAQ:GOOGL"
  };

  if (specialMap[t]) return specialMap[t];
  if (t.endsWith("=X")) return `FX:${t.replace("=X", "")}`;
  if (t.endsWith(".MC")) return `BME:${t.replace(".MC", "")}`;
  if (t.endsWith(".DE")) return `XETR:${t.replace(".DE", "")}`;
  if (t.endsWith(".PA")) return `EURONEXT:${t.replace(".PA", "")}`;
  if (t.endsWith(".AS")) return `EURONEXT:${t.replace(".AS", "")}`;
  if (t.endsWith(".MI")) return `MIL:${t.replace(".MI", "")}`;
  if (t.endsWith(".L")) return `LSE:${t.replace(".L", "")}`;
  return t;
}

function renderFibRow(level, targetPrice, currentPrice, icon, isGolden = false, item = null) {
  const isReached = currentPrice <= targetPrice;
  const distPct = (((currentPrice - targetPrice) / targetPrice) * 100).toFixed(1);
  const goldenClass = isGolden ? "fib-golden" : "";
  const activeClass = isReached ? "active-level" : "";

  let distLabel = "";
  if (isReached) {
    distLabel = `<span style="color: #5cc092; font-weight: 600;">✓ Alcanzado (-${Math.abs(distPct)}%)</span>`;
  } else {
    distLabel = `<span>A +${distPct}%</span>`;
  }

  const fibLiq = (item && item.liquidity && item.liquidity.fib_liquidity)
    ? item.liquidity.fib_liquidity[level]
    : null;
  let volBarHtml = "";
  let liqBadgeHtml = "";
  let liqTooltip = "";

  if (fibLiq) {
    const strength = Math.max(4, Math.min(100, fibLiq.strength_pct || 0));
    const tierCls = `tier-${(fibLiq.tier || "LOW").toLowerCase()}`;
    volBarHtml = `<div class="fib-vol-bar ${tierCls}" style="width: ${strength}%;"></div>`;

    let shortBadge = `💧 ${strength}%`;
    if (fibLiq.is_poc || fibLiq.tier === "POC_WALL") shortBadge = "🏦 POC";
    else if (fibLiq.tier === "HIGH") shortBadge = `🏦 ${strength}%`;
    else if (fibLiq.tier === "LOW") shortBadge = "🕳️ LVN";

    liqBadgeHtml = `<span class="fib-liq-badge ${tierCls}">${shortBadge}</span>`;
    liqTooltip = ` | Liquidez institucional: ${fibLiq.badge || shortBadge} (${strength}%)`;
  }

  const dec = (item && typeof item.decimals === "number") ? item.decimals : 2;
  const rawPriceCopy = typeof targetPrice === "number" ? targetPrice.toFixed(dec) : `${targetPrice}`;

  return `
    <div class="fib-row ${goldenClass} ${activeClass}" data-copy-price="${rawPriceCopy}" data-fib-level="${level}" title="Clic para copiar ${formatPrice(targetPrice, item)}${escapeHtml(liqTooltip)}">
      ${volBarHtml}
      <span class="fib-level-tag">
        <span>${icon}</span>
        <span>${level} ${isGolden ? "(Áureo)" : ""}</span>
        ${liqBadgeHtml}
      </span>
      <span class="fib-target-price">${formatPrice(targetPrice, item)}</span>
      <span class="fib-distance">${distLabel}</span>
    </div>
  `;
}

function formatCurrency(val, decimals = 2) {
  if (val === null || val === undefined) return "—";
  if (typeof val !== "number") val = parseFloat(val) || 0;
  const d = (typeof decimals === "number" && decimals >= 0) ? decimals : 2;
  return val.toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function formatPrice(val, item = null) {
  const sym = (item && item.currency) ? item.currency : EuroView.quote ? "€" : "$";
  const dec = (item && typeof item.decimals === "number") ? item.decimals : 2;
  return sym === "puntos" ? `${formatCurrency(val, dec)} puntos` : `${sym}${formatCurrency(val, dec)}`;
}

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }

  toast.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5cc092" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    <span>${message}</span>
  `;

  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 4000);
}

/* ==========================================================================
   MÓDULO 1: CONTROLADOR DE LA CALCULADORA DE GESTIÓN DE RIESGO
   ========================================================================== */

let currentCalcAsset = null;

function resolveActiveCalcStop(item, risk) {
  const entry = risk.entry_price || item.current_price;
  if (currentCalcSlMode === "SSL" && risk.ssl_stop_loss && risk.ssl_stop_loss > 0) {
    const slVal = risk.ssl_stop_loss;
    const pct = risk.ssl_risk_pct || (entry > 0 ? ((entry - slVal) / entry) * 100 : 5.0);
    return {
      sl: slVal,
      riskPct: Math.max(0.1, pct),
      label: "🧲 Stop Bajo Piscina Liquidez (SSL)"
    };
  }
  if (currentCalcSlMode === "ATR" && risk.atr_stop_loss && risk.atr_stop_loss > 0) {
    const slVal = risk.atr_stop_loss;
    const pct = risk.atr_risk_pct || (entry > 0 ? ((entry - slVal) / entry) * 100 : 5.0);
    return {
      sl: slVal,
      riskPct: Math.max(0.1, pct),
      label: "🌊 Stop Volatilidad (2x ATR)"
    };
  }
  const slVal = risk.stop_loss || (entry * 0.95);
  const pct = risk.risk_pct || (entry > 0 ? ((entry - slVal) / entry) * 100 : 5.0);
  return {
    sl: slVal,
    riskPct: Math.max(0.1, pct),
    label: "🛡️ Stop Fibonacci (78.6%)"
  };
}

function openPositionCalculator(item) {
  currentCalcAsset = item;
  const risk = item.risk_mgmt || {
    entry_price: item.current_price,
    entry_label: `Al mercado (${formatPrice(item.current_price, item)})`,
    stop_loss: item.fib_levels["78.6%"] * 0.98,
    risk_pct: 5.0,
    risk_per_share: Math.max(minRiskUnit, item.current_price * 0.05),
    take_profit_1: item.fib_levels["38.2%"],
    reward_1_pct: 10.0,
    rr_ratio_1: 1.5,
    take_profit_2: item.max,
    reward_2_pct: 20.0,
    rr_ratio_2: 2.5,
    rr_rating: "🟢 Favorable (R:R > 1:2)"
  };

  // Si el activo tiene barrido de liquidez o absorción Smart Money, activar Stop SSL por defecto
  const hasSmartMoney = Boolean(
    risk.ssl_stop_loss && risk.ssl_stop_loss > 0 &&
    (item.liquidity?.has_sweep || item.liquidity?.has_absorption || (risk.ssl_rr_ratio_2 && risk.ssl_rr_ratio_2 > (risk.rr_ratio_2 || 0)))
  );
  currentCalcSlMode = hasSmartMoney ? "SSL" : "FIBO";

  const modal = document.getElementById("positionCalcModal");
  if (!modal) return;

  const minRiskUnit = ((item.decimals || 2) >= 4) ? 0.0001 : 0.01;

  document.getElementById("calcAssetTitle").textContent = `Calculadora de Riesgo: ${item.tab} (${item.ticker})`;
  const currencyLabel = document.querySelector('#positionCalcModal .currency-symbol');
  if (currencyLabel) currencyLabel.textContent = item.currency || '$';
  document.getElementById("calcAssetSubtitle").textContent = `Plan de gestión de capital institucional para ${item.name}`;

  const elAtrBadge = document.getElementById("calcAtrInfoBadge");
  if (elAtrBadge) {
    if (item.atr_14 && item.atr_14 > 0) {
      elAtrBadge.textContent = `ATR(14): ${formatPrice(item.atr_14, item)} (${(item.atr_pct || 0).toFixed(1)}%)`;
    } else {
      elAtrBadge.textContent = "ATR(14): N/D";
    }
  }

  document.querySelectorAll(".btn-sl-mode").forEach(b => {
    if (b.dataset.slMode === "ATR") {
      b.disabled = !(risk.atr_stop_loss && risk.atr_stop_loss > 0);
    } else if (b.dataset.slMode === "SSL") {
      b.disabled = !(risk.ssl_stop_loss && risk.ssl_stop_loss > 0);
    }
    b.classList.toggle("active", b.dataset.slMode === currentCalcSlMode);
  });

  document.getElementById("calcEntryPrice").textContent = formatPrice(risk.entry_price, item);
  document.getElementById("calcEntryType").textContent = risk.entry_label || "Precio de Mercado";

  document.getElementById("calcTP1").textContent = formatPrice(risk.take_profit_1, item);
  document.getElementById("calcTP2").textContent = formatPrice(risk.take_profit_2, item);

  // Resetear preset por defecto a 100€
  const calcRiskInput = document.getElementById("calcRiskInput");
  if (calcRiskInput) calcRiskInput.value = "100";
  document.querySelectorAll(".btn-risk-preset").forEach(b => {
    b.classList.toggle("active", b.dataset.amount === "100");
  });

  recalcPositionPlan();
  modal.style.display = "flex";
}

function formatFractionalUnits(val) {
  if (val >= 0.1) return val.toFixed(2);
  if (val >= 0.001) return val.toFixed(4);
  return val.toFixed(6);
}

function recalcPositionPlan() {
  if (!currentCalcAsset) return;
  const item = currentCalcAsset;
  const sym = item.currency || "$";
  const minRiskUnit = ((item.decimals || 2) >= 4) ? 0.0001 : 0.01;
  const risk = item.risk_mgmt || {
    entry_price: item.current_price,
    stop_loss: item.fib_levels["78.6%"] * 0.98,
    take_profit_1: item.fib_levels["38.2%"],
    take_profit_2: item.max,
    reward_1_pct: 10.0,
    reward_2_pct: 20.0
  };

  const inputEl = document.getElementById("calcRiskInput");
  const budget = Math.max(1, parseFloat(inputEl ? inputEl.value : 100) || 100);

  const entry = risk.entry_price || item.current_price;
  const activeStop = resolveActiveCalcStop(item, risk);
  const sl = activeStop.sl;
  const riskPerShare = Math.max(minRiskUnit, entry - sl);

  // Actualizar tarjeta de Stop Loss y ratios R:R dinámicamente según modo FIBO / ATR
  const elSlLabel = document.getElementById("calcStopLossLabel");
  const elSlVal = document.getElementById("calcStopLoss");
  const elSlPct = document.getElementById("calcRiskPct");
  const elTp1Ratio = document.getElementById("calcTP1Ratio");
  const elTp2Ratio = document.getElementById("calcTP2Ratio");

  if (elSlLabel) elSlLabel.textContent = activeStop.label;
  if (elSlVal) elSlVal.textContent = formatPrice(sl, item);
  if (elSlPct) elSlPct.textContent = `-${activeStop.riskPct.toFixed(1)}% riesgo`;

  const rew1PerShare = Math.max(0, (risk.take_profit_1 || entry) - entry);
  const rew2PerShare = Math.max(0, (risk.take_profit_2 || item.max) - entry);
  const rr1 = (rew1PerShare / riskPerShare).toFixed(2);
  const rr2 = (rew2PerShare / riskPerShare).toFixed(2);
  const rew1Pct = entry > 0 ? (rew1PerShare / entry) * 100 : (risk.reward_1_pct || 0);
  const rew2Pct = entry > 0 ? (rew2PerShare / entry) * 100 : (risk.reward_2_pct || 0);

  if (elTp1Ratio) elTp1Ratio.textContent = `+${rew1Pct.toFixed(1)}% | R:R 1:${rr1}`;
  if (elTp2Ratio) elTp2Ratio.textContent = `+${rew2Pct.toFixed(1)}% | R:R 1:${rr2}`;

  const exactShares = budget / riskPerShare;
  const wholeShares = Math.floor(exactShares);
  const isFractionalOnly = wholeShares <= 0;
  const effectiveShares = isFractionalOnly ? exactShares : wholeShares;

  const totalCapital = effectiveShares * entry;
  const actualLoss = effectiveShares * riskPerShare;
  const reward2 = (risk.take_profit_2 - entry) * effectiveShares;
  const effectiveRR = (actualLoss > 0 ? (reward2 / actualLoss) : 1).toFixed(2);

  const elShares = document.getElementById("calcSharesCount");
  const elSharesSub = document.getElementById("calcSharesSub");
  const elCapital = document.getElementById("calcTotalCapital");
  const elLoss = document.getElementById("calcMaxLoss");
  const elProfit = document.getElementById("calcMaxProfit");
  const elRatio = document.getElementById("calcProfitRatio");
  const adviceBanner = document.getElementById("calcAdviceBanner");
  const adviceIcon = adviceBanner ? adviceBanner.querySelector(".calc-advice-icon") : null;
  const adviceEl = document.getElementById("calcAdviceText");

  const earnNote = (item.earnings && item.earnings.warning_level === "IMMINENT" && item.earnings.label)
    ? `<br><span style="color:#fbbf24;"><strong>${escapeHtml(item.earnings.label)}:</strong> Valora reducir lote a la mitad ante posible gap de resultados.</span>`
    : "";

  const sslNote = (currentCalcSlMode !== "SSL" && risk.ssl_pool_ref && risk.ssl_stop_loss && sl >= risk.ssl_pool_ref)
    ? `<br><span style="color:#9bb8cc;"><strong>🧲 Aviso de Liquidez SMC:</strong> Hay una piscina de stops en <strong>${formatPrice(risk.ssl_pool_ref, item)}</strong>. Valora el método <em>Bajo Piscina Liquidez (${formatPrice(risk.ssl_stop_loss, item)})</em> para evitar barridos institucionales.</span>`
    : "";

  if (isFractionalOnly) {
    const fracStr = formatFractionalUnits(exactShares);
    if (elShares) elShares.textContent = fracStr;
    if (elSharesSub) elSharesSub.textContent = "títulos fraccionados (0 enteros)";
    if (elCapital) elCapital.textContent = `${sym}${formatCurrency(totalCapital, 2)}`;
    if (elLoss) elLoss.textContent = `-${sym}${formatCurrency(actualLoss, 2)}`;
    if (elProfit) elProfit.textContent = `+${sym}${formatCurrency(reward2, 2)}`;
    if (elRatio) elRatio.textContent = `Ratio R:R 1:${effectiveRR}`;

    if (adviceBanner) adviceBanner.classList.add("calc-advice-warning");
    if (adviceIcon) adviceIcon.textContent = "⚠️";
    if (adviceEl) {
      adviceEl.innerHTML = `<strong>Presupuesto inferior al riesgo de 1 título entero (-${formatPrice(riskPerShare, item)}):</strong> Para respetar estrictamente tu límite de <strong>-${sym}${formatCurrency(budget, 2)}</strong>, debes comprar <strong>${fracStr} títulos fraccionados</strong> (inversión: <strong>${sym}${formatCurrency(totalCapital, 2)}</strong>). Si tu broker no permite fracciones, comprar <strong>1 título entero</strong> requerirá invertir <strong>${formatPrice(entry, item)}</strong> y asumir un riesgo real de <strong>-${formatPrice(riskPerShare, item)}</strong>.${sslNote}${earnNote}`;
    }
  } else {
    if (elShares) elShares.textContent = `${wholeShares}`;
    if (elSharesSub) {
      const wholeLabel = wholeShares === 1 ? "1 acción entera" : `${wholeShares} acciones enteras`;
      elSharesSub.textContent = `${wholeLabel} (${exactShares.toFixed(2)} fracc.)`;
    }
    if (elCapital) elCapital.textContent = `${sym}${formatCurrency(totalCapital, 2)}`;
    if (elLoss) elLoss.textContent = `-${sym}${formatCurrency(actualLoss, 2)}`;
    if (elProfit) elProfit.textContent = `+${sym}${formatCurrency(reward2, 2)}`;
    if (elRatio) elRatio.textContent = `Ratio R:R 1:${effectiveRR}`;

    if (adviceBanner) adviceBanner.classList.remove("calc-advice-warning");
    if (adviceIcon) adviceIcon.textContent = "💡";
    if (adviceEl) {
      adviceEl.innerHTML = `Comprando <strong>${wholeShares} ${wholeShares === 1 ? 'acción' : 'acciones'}</strong> a <strong>${formatPrice(entry, item)}</strong>, tu pérdida máxima estará acotada exactamente a <strong>-${sym}${formatCurrency(actualLoss, 2)}</strong> si el precio toca tu Stop Loss en <strong>${formatPrice(sl, item)}</strong>. Si el activo alcanza tu objetivo principal (TP 2 en ${formatPrice(risk.take_profit_2, item)}), tu beneficio neto estimado será de <strong>+${sym}${formatCurrency(reward2, 2)}</strong>.${sslNote}${earnNote}`;
    }
  }
}

function registerCalcPlanIntoPortfolio() {
  if (!currentCalcAsset) return;
  const item = currentCalcAsset;
  const minRiskUnit = ((item.decimals || 2) >= 4) ? 0.0001 : 0.01;
  const risk = item.risk_mgmt || {};
  const inputEl = document.getElementById("calcRiskInput");
  const budget = Math.max(1, parseFloat(inputEl ? inputEl.value : 100) || 100);
  const entry = risk.entry_price || item.current_price;
  const activeStop = resolveActiveCalcStop(item, risk);
  const riskPerShare = Math.max(minRiskUnit, entry - activeStop.sl);
  const exactShares = budget / riskPerShare;
  const wholeShares = Math.floor(exactShares);
  const effectiveShares = wholeShares > 0 ? wholeShares : parseFloat(formatFractionalUnits(exactShares));
  const tp2 = risk.take_profit_2 || item.max;

  const calcModal = document.getElementById("positionCalcModal");
  if (calcModal) calcModal.style.display = "none";

  const slModeText = currentCalcSlMode === "SSL"
    ? "Stop Piscina SSL"
    : (currentCalcSlMode === "ATR" ? "Stop 2x ATR" : "Stop Fibo 78.6%");

  openPortfolioModal({
    ticker: item.ticker,
    shares: effectiveShares,
    input_meta: EuroView.inputMeta(item),
    avg_price: entry,
    custom_sl: activeStop.sl,
    custom_tp: tp2,
    notes: `Plan calculado (${slModeText}, riesgo ${item.currency || "$"}${budget})`,
    merge: true
  });
}

function copyTradingPlanToClipboard() {
  if (!currentCalcAsset) return;
  const item = currentCalcAsset;
  const sym = item.currency || "$";
  const minRiskUnit = ((item.decimals || 2) >= 4) ? 0.0001 : 0.01;
  const risk = item.risk_mgmt || {};
  const inputEl = document.getElementById("calcRiskInput");
  const budget = Math.max(1, parseFloat(inputEl ? inputEl.value : 100) || 100);
  const entry = risk.entry_price || item.current_price;
  const activeStop = resolveActiveCalcStop(item, risk);
  const sl = activeStop.sl;
  const riskPerShare = Math.max(minRiskUnit, entry - sl);
  const exactShares = budget / riskPerShare;
  const wholeShares = Math.floor(exactShares);
  const isFractionalOnly = wholeShares <= 0;
  const effectiveShares = isFractionalOnly ? exactShares : wholeShares;
  const sharesLabel = isFractionalOnly
    ? `${formatFractionalUnits(exactShares)} títulos fraccionados (1 título entero arriesgaría -${formatPrice(riskPerShare, item)})`
    : `${wholeShares} ${wholeShares === 1 ? 'acción' : 'acciones'} (${exactShares.toFixed(2)} fracc.)`;
  const totalCapital = effectiveShares * entry;
  const reward2 = ((risk.take_profit_2 || item.max) - entry) * effectiveShares;
  const effectiveRR = ((effectiveShares * riskPerShare) > 0 ? (reward2 / (effectiveShares * riskPerShare)) : 2).toFixed(2);

  const text = 
`📋 PLAN DE TRADING: ${item.tab} (${item.ticker})
━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 Precio Entrada: ${formatPrice(entry, item)}
${activeStop.label}: ${formatPrice(sl, item)} (-${activeStop.riskPct.toFixed(1)}%)
🎯 Take Profit 1 (38.2%): ${formatPrice(risk.take_profit_1 || 0, item)} (+${(risk.reward_1_pct || 0).toFixed(1)}%)
🚀 Take Profit 2 (Máx): ${formatPrice(risk.take_profit_2 || 0, item)} (+${(risk.reward_2_pct || 0).toFixed(1)}%)
⚖️ Ratio Riesgo/Beneficio: 1:${effectiveRR}
━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Posición Recomendada: ${sharesLabel}
💵 Capital Necesario: ${sym}${formatCurrency(totalCapital, 2)}
🛑 Pérdida Máxima Asumida: -${sym}${formatCurrency(effectiveShares * riskPerShare, 2)}
🏆 Ganancia Estimada (TP 2): +${sym}${formatCurrency(reward2, 2)}`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast("¡Plan de trading copiado al portapapeles!");
    }).catch(() => {
      showToast("Copiado al portapapeles.");
    });
  } else {
    showToast("Selecciona y copia los detalles de la tarjeta.");
  }
}

/* ==========================================================================
   MÓDULO 2 & 3: CONTROLADOR DE MODO, VENTA PARCIAL Y DIARIO DE TRADING
   ========================================================================== */

function renderModeToolbarControls(mode) {
  const filterChips = document.getElementById("filterChips");
  const sortSelect = document.getElementById("sortSelect");

  if (mode === "SELL") {
    if (filterChips) {
      filterChips.innerHTML = `
        <button class="chip-btn ${currentFilter === 'ALL' ? 'active' : ''}" data-filter="ALL">
          Todos <span class="chip-count" id="countAll">0</span>
        </button>
        <button class="chip-btn chip-red ${currentFilter === 'SELL_STRONG' ? 'active' : ''}" data-filter="SELL_STRONG">
          <span class="chip-dot dot-red"></span>
          🔥 Venta Fuerte (Score ≥ 70) <span class="chip-count" id="countSellStrong">0</span>
        </button>
        <button class="chip-btn chip-orange ${currentFilter === 'SELL_ALERT' ? 'active' : ''}" data-filter="SELL_ALERT">
          <span class="chip-dot dot-orange"></span>
          🟠 Toma Parcial / Techo <span class="chip-count" id="countSellAlert">0</span>
        </button>
        <button class="chip-btn chip-gold ${currentFilter === 'OVERBOUGHT' ? 'active' : ''}" data-filter="OVERBOUGHT">
          <span class="chip-dot dot-gold"></span>
          📈 RSI Alto (≥ 62) <span class="chip-count" id="countOverbought">0</span>
        </button>
        <button class="chip-btn chip-green ${currentFilter === 'HOLD_ACCUM' ? 'active' : ''}" data-filter="HOLD_ACCUM">
          <span class="chip-dot dot-green"></span>
          🟢 Sin Presión / Mantener <span class="chip-count" id="countHoldAccum">0</span>
        </button>
      `;
    }
    if (sortSelect) {
      sortSelect.innerHTML = `
        <option value="score_desc">🔥 Mayor Presión de Venta (0-100)</option>
        <option value="gain_desc">Mayor Subida desde Mín %</option>
        <option value="rsi_desc">RSI Más Alto (Sobrecompra)</option>
        <option value="high_dist_asc">Más Cerca del Techo (Máx)</option>
        <option value="price_desc">Precio: Mayor a Menor</option>
        <option value="price_asc">Precio: Menor a Mayor</option>
        <option value="name_asc">Nombre (A - Z)</option>
      `;
      sortSelect.value = currentSort;
    }
  } else if (mode === "BUY") {
    if (filterChips) {
      filterChips.innerHTML = `
        <button class="chip-btn ${currentFilter === 'ALL' ? 'active' : ''}" data-filter="ALL">
          Todos <span class="chip-count" id="countAll">0</span>
        </button>
        <button class="chip-btn chip-fire ${currentFilter === 'CONFLUENCE' ? 'active' : ''}" data-filter="CONFLUENCE">
          <span class="chip-dot dot-fire"></span>
          🔥 Alta Confluencia (Score ≥ 70) <span class="chip-count" id="countConfluence">0</span>
        </button>
        <button class="chip-btn chip-green ${currentFilter === 'BUY_ZONE' ? 'active' : ''}" data-filter="BUY_ZONE">
          <span class="chip-dot dot-green"></span>
          Zona de Compra (≥50%) <span class="chip-count" id="countBuy">0</span>
        </button>
        <button class="chip-btn chip-gold ${currentFilter === 'GOLDEN' ? 'active' : ''}" data-filter="GOLDEN">
          <span class="chip-dot dot-gold"></span>
          Zona Áurea (61.8%) <span class="chip-count" id="countGolden">0</span>
        </button>
        <button class="chip-btn chip-liquidity ${currentFilter === 'LIQUIDITY' ? 'active' : ''}" data-filter="LIQUIDITY">
          <span class="chip-dot dot-liquidity"></span>
          🏦 Liquidez / Barrido <span class="chip-count" id="countLiquidity">0</span>
        </button>
        <button class="chip-btn chip-yellow ${currentFilter === 'WATCH' ? 'active' : ''}" data-filter="WATCH">
          <span class="chip-dot dot-yellow"></span>
          En Observación <span class="chip-count" id="countWatch">0</span>
        </button>
      `;
    }
    if (sortSelect) {
      sortSelect.innerHTML = `
        <option value="score_desc">🔥 Mayor Score Técnico (0-100)</option>
        <option value="liquidity_desc">🏦 Mayor Liquidez Institucional (0-100)</option>
        <option value="rvol_desc">🐋 Mayor Volumen Relativo (RVOL)</option>
        <option value="drop_desc">Mayor Caída %</option>
        <option value="rsi_asc">RSI Más Bajo (Sobreventa)</option>
        <option value="drop_asc">Menor Caída %</option>
        <option value="price_asc">Precio: Menor a Mayor</option>
        <option value="price_desc">Precio: Mayor a Menor</option>
        <option value="name_asc">Nombre (A - Z)</option>
      `;
      sortSelect.value = currentSort;
    }
  }

  if (marketData && marketData.data) {
    updateFilterBadges(marketData.data);
  }
}

function setAppMode(mode) {
  const prevMode = currentAppMode;
  currentAppMode = mode;
  document.querySelectorAll(".mode-tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });

  if (prevMode !== mode && (mode === "BUY" || mode === "SELL")) {
    currentFilter = "ALL";
    currentSort = "score_desc";
    renderModeToolbarControls(mode);
  }

  const buyLegend = document.getElementById("buyLegendBar");
  const sellLegend = document.getElementById("sellLegendBar");
  const controlsToolbar = document.querySelector(".controls-toolbar");
  const assetsGrid = document.getElementById("assetsGrid");
  const emptyState = document.getElementById("emptyState");
  const journalSection = document.getElementById("journalSection");
  const portfolioSection = document.getElementById("portfolioSection");

  if (mode === "BUY") {
    if (buyLegend) buyLegend.style.display = "flex";
    if (sellLegend) sellLegend.style.display = "none";
    if (controlsToolbar) controlsToolbar.style.display = "flex";
    if (assetsGrid) assetsGrid.style.display = "grid";
    if (journalSection) journalSection.style.display = "none";
    if (portfolioSection) portfolioSection.style.display = "none";
    renderFilteredCards();
  } else if (mode === "SELL") {
    if (buyLegend) buyLegend.style.display = "none";
    if (sellLegend) sellLegend.style.display = "flex";
    if (controlsToolbar) controlsToolbar.style.display = "flex";
    if (assetsGrid) assetsGrid.style.display = "grid";
    if (journalSection) journalSection.style.display = "none";
    if (portfolioSection) portfolioSection.style.display = "none";
    renderFilteredCards();
  } else if (mode === "JOURNAL") {
    if (buyLegend) buyLegend.style.display = "none";
    if (sellLegend) sellLegend.style.display = "none";
    if (controlsToolbar) controlsToolbar.style.display = "none";
    if (assetsGrid) assetsGrid.style.display = "none";
    if (emptyState) emptyState.style.display = "none";
    if (journalSection) journalSection.style.display = "flex";
    if (portfolioSection) portfolioSection.style.display = "none";
    loadAndRenderJournal();
  } else if (mode === "PORTFOLIO") {
    if (buyLegend) buyLegend.style.display = "none";
    if (sellLegend) sellLegend.style.display = "none";
    if (controlsToolbar) controlsToolbar.style.display = "none";
    if (assetsGrid) assetsGrid.style.display = "none";
    if (emptyState) emptyState.style.display = "none";
    if (journalSection) journalSection.style.display = "none";
    if (portfolioSection) portfolioSection.style.display = "flex";
    loadAndRenderPortfolio();
  }
}

function openPartialSellModal(item) {
  currentSellAsset = item;
  const modal = document.getElementById("partialSellModal");
  if (!modal) return;

  const sell = item.sell_mgmt || {
    sell_score: 50,
    sell_signal: "Toma Parcial",
    sell_action: "Asegurar beneficios",
    gain_from_low_pct: 10,
    dist_to_high_pct: 3,
    ext_127: item.max * 1.05,
    ext_161: item.max * 1.15,
    dist_to_ext127_pct: 5,
    dist_to_ext161_pct: 15,
    trailing_stop: item.current_price * 0.945
  };

  document.getElementById("sellModalTitle").textContent = `Simulador de Venta: ${item.tab} (${item.ticker})`;
  document.getElementById("sellModalSubtitle").textContent = `Estrategia de salida institucional para ${item.name}`;

  document.getElementById("sellCurrPrice").textContent = formatPrice(item.current_price, item);
  document.getElementById("sellGainFromLow").textContent = `+${sell.gain_from_low_pct.toFixed(1)}% desde mín`;

  document.getElementById("sellExt127").textContent = formatPrice(sell.ext_127, item);
  document.getElementById("sellExt127Dist").textContent = `a ${sell.dist_to_ext127_pct >= 0 ? '+' : ''}${sell.dist_to_ext127_pct.toFixed(1)}%`;

  document.getElementById("sellExt161").textContent = formatPrice(sell.ext_161, item);
  document.getElementById("sellExt161Dist").textContent = `a ${sell.dist_to_ext161_pct >= 0 ? '+' : ''}${sell.dist_to_ext161_pct.toFixed(1)}%`;

  document.getElementById("sellTrailingStop").textContent = formatPrice(sell.trailing_stop, item);

  const sharesInput = document.getElementById("sellSharesInput");
  if (sharesInput) sharesInput.value = "10";
  document.querySelectorAll(".btn-sell-preset").forEach(b => {
    b.classList.toggle("active", b.dataset.pct === "50");
  });

  recalcPartialSell();
  modal.style.display = "flex";
}

function recalcPartialSell() {
  if (!currentSellAsset) return;
  const item = currentSellAsset;
  const sym = item.currency || "$";
  const sell = item.sell_mgmt || {};

  const sharesInput = document.getElementById("sellSharesInput");
  const rawTotal = parseFloat(sharesInput ? sharesInput.value : 10);
  const totalShares = (!isNaN(rawTotal) && rawTotal > 0) ? rawTotal : 10;
  const isWholePosition = Number.isInteger(totalShares) && totalShares >= 2;

  const activePreset = document.querySelector(".btn-sell-preset.active");
  const pct = parseInt(activePreset ? activePreset.dataset.pct : 50, 10) || 50;

  let sharesToSell;
  if (pct >= 100) {
    sharesToSell = totalShares;
  } else if (isWholePosition) {
    sharesToSell = Math.max(1, Math.round(totalShares * (pct / 100)));
  } else {
    sharesToSell = totalShares * (pct / 100);
  }
  const remainingShares = Math.max(0, totalShares - sharesToSell);
  const fmtUnits = (n) => Number.isInteger(n) ? `${n}` : formatFractionalUnits(n);

  const cashOut = sharesToSell * item.current_price;
  const remainingVal = remainingShares * item.current_price;
  const tStop = sell.trailing_stop || (item.current_price * 0.945);

  const elCashOut = document.getElementById("sellCashOut");
  const elSharesSell = document.getElementById("sellSharesToSell");
  const elRemainShares = document.getElementById("sellRemainingShares");
  const elRemainVal = document.getElementById("sellRemainingVal");
  const elProtectStop = document.getElementById("sellProtectStop");
  const adviceEl = document.getElementById("sellAdviceText");

  if (elCashOut) elCashOut.textContent = `${sym}${formatCurrency(cashOut, 2)}`;
  if (elSharesSell) elSharesSell.textContent = `${fmtUnits(sharesToSell)} ${sharesToSell === 1 ? 'título vendido' : 'títulos vendidos'} (${pct}%)`;
  if (elRemainShares) elRemainShares.textContent = fmtUnits(remainingShares);
  if (elRemainVal) elRemainVal.textContent = `${sym}${formatCurrency(remainingVal, 2)} en posición`;
  if (elProtectStop) elProtectStop.textContent = formatPrice(tStop, item);

  if (adviceEl) {
    if (remainingShares > 0) {
      adviceEl.innerHTML = `Vendiendo <strong>${fmtUnits(sharesToSell)} títulos (${pct}%)</strong> a <strong>${formatPrice(item.current_price, item)}</strong> aseguras inmediatamente <strong>+${sym}${formatCurrency(cashOut, 2)} en efectivo</strong>. Dejas <strong>${fmtUnits(remainingShares)} títulos</strong> corriendo sin riesgo con un Trailing Stop protector fijado en <strong>${formatPrice(tStop, item)}</strong>.`;
    } else {
      adviceEl.innerHTML = `Venta total del 100% de la posición: Liquidando los <strong>${fmtUnits(totalShares)} títulos</strong> recoges un total de <strong>+${sym}${formatCurrency(cashOut, 2)} en efectivo</strong> y cierras la operación con éxito.`;
    }
  }
}

let journalUndoIds = [];
let journalArchiveBusy = false;

async function journalRequest(url, body) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || "No se pudo guardar el cambio en el Diario");
  return data;
}

async function archiveJournal(body) {
  if (journalArchiveBusy) return;
  journalArchiveBusy = true;
  try {
    const data = await journalRequest("/api/journal/archive", body);
    const restoring = body.archived === false;
    if (data.changed_ids.length) {
      journalUndoIds = restoring ? journalUndoIds.filter(id => !data.changed_ids.includes(id)) : data.changed_ids;
    }
    document.getElementById("journalArchiveNotice").hidden = !journalUndoIds.length;
    document.getElementById("journalArchiveMessage").textContent = `${journalUndoIds.length} señal(es) archivada(s). Sus resultados siguen contando.`;
    await loadAndRenderJournal();
    showToast(data.changed_ids.length ? (restoring ? "Señales restauradas" : "Archivado guardado · Estadísticas conservadas") : "No hay señales que cambiar");
  } catch (error) { showToast(error.message); }
  finally { journalArchiveBusy = false; }
}

function journalExitSummary(entry, fmtRef) {
  const price = value => value == null ? "No registrado" : formatPrice(value, fmtRef);
  if (entry.status === "TP2_ALCANZADO") return `50 % en TP1: ${price(entry.tp1)} · 50 % en TP2: ${price(entry.tp2)}`;
  if (entry.status === "BREAKEVEN_EJECUTADO") return `50 % en TP1: ${price(entry.tp1)} · 50 % en la entrada: ${price(entry.entry_price)}`;
  if (entry.status === "STOP_EJECUTADO") return `100 % en el stop: ${price(entry.stop_loss)}`;
  return "Salida simulada no registrada";
}

let journalScenario = "confirmation";
let journalVisibleClosedIds = [];
document.getElementById("journalScenario")?.addEventListener("change", event => {
  journalScenario = event.target.value;
  loadAndRenderJournal();
});

function renderScenarioOverview(data) {
  const host = document.getElementById("scenarioOverview");
  if (!host) return;
  const watches = Object.entries(data.watches || {});
  const accumulation = journalScenario === "accumulation";
  const campaigns = data.accumulation || [];
  const number = value => Number(value || 0).toLocaleString("es-ES", { maximumFractionDigits: 2 });
  const confirmed = (data.entries || []).filter(e => e.strategy === "confirmation");
  const comparison = confirmed.map(e => `<p class="journal-method-note">${escapeHtml(e.ticker)} · Capital simulado ${number(e.simulated_budget || 1000)} ${escapeHtml(e.currency || "$")} · Resultado ${number((e.final_return_pct ?? e.current_return_pct ?? 0) * (e.simulated_budget || 1000) / 100)} ${escapeHtml(e.currency || "$")} (${number(e.final_return_pct ?? e.current_return_pct)} %) · Caída máxima conservadora ${number(e.max_drawdown_pct)} %</p>`).join("");
  host.innerHTML = accumulation ? `<p class="journal-method-note">Campañas independientes · ${campaigns.length} registradas · ${campaigns.filter(c => c.status === "CERRADA").length} cerradas · ${campaigns.filter(c => c.status === "CERRADA" && c.pnl > 0).length} con beneficio. Los importes se expresan en la divisa de cada activo y no se suman entre divisas. La caída máxima se mide sobre el presupuesto reservado en las observaciones disponibles.</p>` + campaigns.map(c => `
    <article class="journal-kpi-card"><h3>${escapeHtml(c.ticker)} · ${escapeHtml(c.status)}</h3>
      <p>${c.tranches.length}/3 tramos · Capital ${number(c.invested)} / ${number(c.budget)} ${escapeHtml(c.currency)}</p>
      <p>Precio medio ${number(c.average_price)} · Unidades ${number(c.shares)} · Cotización/salida ${number(c.current_price)}</p>
      <p>Resultado ${number(c.pnl)} ${escapeHtml(c.currency)} (${number(c.return_pct)} % invertido; ${number(c.return_on_budget_pct)} % del presupuesto) · Caída máxima ${number(c.max_drawdown_pct)} %</p>
      <p>Invalidación ${number(c.invalidation)} · Objetivo ${number(c.target)}</p>
      ${c.tranches.map(t => `<p>${escapeHtml(t.date)} · ${number(t.shares)} unidades a ${number(t.price)} · ${number(t.amount)} ${escapeHtml(c.currency)}</p>`).join("")}
    </article>`).join("") + (campaigns.length ? "" : '<p class="journal-method-note">Sin campañas todavía. Se necesita vigilancia y confirmación posterior; no se reconstruyen compras pasadas.</p>')
    : journalScenario === "confirmation" ? `<p class="journal-method-note">${watches.length} activos vigilados. Techo de las dos últimas velas horarias completas; se fija tras el primer cierre por encima y exige un segundo cierre horario consecutivo. Si existe historia del S&P 500, bloquea compras de acciones cuando su último cierre está bajo la media de 20 sesiones. Sin historia del índice, el contexto se marca sin confirmar. No incluye un filtro sectorial.</p>` + watches.map(([ticker, w]) => `<p class="journal-method-note">${escapeHtml(ticker)} · ${escapeHtml(w.state)} · Techo cercano ${w.state === "SIN_DATOS_HORARIOS" ? "Pendiente de datos" : formatPrice(w.breakout, w)} · Cierres ${number(w.confirmations)}/2 · ${w.interval === "1h" ? "Velas de 1 hora" : "Pendiente de actualizar"} · Desde ${escapeHtml(w.since)} · ${escapeHtml(w.market_context || "Mercado sin confirmar")}</p>`).join("")
      : '<p class="journal-method-note">Reglas anteriores: zona Fibonacci o score ≥ 70. Se conservan entradas, cierres y seguimiento de posiciones abiertas.</p>';
  if (journalScenario === "confirmation") host.insertAdjacentHTML("beforeend", comparison);
  if (journalScenario === "confirmation") renderJournalWatchboard(host, data);
}

function renderJournalWatchboard(host, data) {
  const watches = Object.entries(data.watches || {});
  const assets = marketData?.data || [];
  const blocked = watches.filter(([, w]) => w.market_context === "Mercado débil: entrada bloqueada").length;
  const hourly = watches.filter(([, w]) => w.confirmations >= 2).length;
  const latest = (data.entries || []).map(e => e.signal_date || "").sort().pop();
  const validAssets = assets.filter(a => !a.is_stale && Number(a.sma_200) > 0 && Number(a.current_price) > 0);
  const above = validAssets.filter(a => a.current_price >= a.sma_200).length;
  const escape = escapeHtml;
  const cards = watches.map(([ticker, watch]) => {
    const asset = assets.find(a => a.ticker === ticker);
    const hasPrice = Number.isFinite(Number(watch.current_price)) && Number(watch.current_price) > 0;
    const hasLevel = Number.isFinite(Number(watch.breakout)) && Number(watch.breakout) > 0;
    const below = hasPrice && hasLevel && watch.current_price < watch.breakout;
    const marketBlocked = watch.market_context === "Mercado débil: entrada bloqueada";
    const missing = watch.state === "SIN_DATOS_HORARIOS" || watch.interval !== "1h";
    const reason = missing ? "Faltan velas horarias" : marketBlocked ? "Bloqueada por el mercado" : below ? "Precio bajo el techo" : watch.confirmations < 2 ? "Esperando cierres horarios" : watch.state === "CONFIRMADA" ? "Confirmación técnica completada" : "Pendiente de tendencia corta";
    const next = missing ? "Esperar datos horarios completos." : marketBlocked ? "El último cierre completo del S&P 500 debe recuperar su media de 20 sesiones. La subida intradía todavía no cuenta." : below ? "Recuperar el techo y mantener los cierres exigidos." : watch.confirmations < 2 ? "Completar dos cierres consecutivos por encima del mismo techo." : "El motor aún debe validar tendencia, objetivos, riesgo y posiciones abiertas antes de registrar una entrada.";
    const fmt = { currency: watch.currency || asset?.currency || "", decimals: asset?.decimals ?? 2 };
    // Precio y techo pertenecen al mismo estado del Diario y comparten su conversión.
    const price = value => formatPrice(value, fmt);
    const gap = hasPrice && hasLevel ? ((watch.current_price / watch.breakout - 1) * 100).toLocaleString("es-ES", { maximumFractionDigits: 2 }) : null;
    return `<article class="journal-watch-card"><div class="journal-watch-heading"><h4>${escape(ticker)}</h4><span>${escape(reason)}</span></div>
      <p class="journal-watch-metrics">Precio observado <strong>${hasPrice ? price(watch.current_price) : "Sin dato"}</strong> · Techo <strong>${hasLevel ? price(watch.breakout) : "Sin dato"}</strong></p>
      <p>Cierres horarios: <strong>${escape(String(watch.confirmations ?? 0))}/2</strong>${gap !== null ? ` · Distancia al techo: ${escape(gap)} %` : ""}</p>
      <p class="journal-watch-next">${escape(next)}</p>
      ${asset?.is_stale ? '<p>Cotización en caché: pendiente de actualización.</p>' : ""}
      <details><summary>Contexto de la vigilancia</summary><p>Desde ${escape(watch.since || "Sin fecha")} · Última vela evaluada: ${escape(watch.last_breakout_day || "Sin dato")}. ${escape(watch.market_context || "Mercado sin confirmar")}.</p><p>La confirmación horaria no garantiza una entrada. Se exige margen mínimo de 2 ATR para el stop y beneficio/riesgo de al menos 1,5 hasta TP1.</p></details></article>`;
  }).join("");
  host.innerHTML = `<section class="journal-watch-summary"><h3>Qué está esperando el Diario</h3>
    <p>${watches.length} activos vigilados · ${hourly} con dos cierres horarios · ${blocked} bloqueados por mercado.</p>
    <p>${blocked ? "Hay recuperaciones individuales, pero el filtro diario del mercado sigue frenando entradas en acciones." : "No hay vigilancias bloqueadas por mercado en este registro. Cada activo debe completar su confirmación y filtro de riesgo."}</p>
    <small>Diario actualizado: ${escape(data.last_updated || "Sin fecha")} · Última señal registrada: ${escape(latest || "Todavía ninguna")}</small></section>
    <section class="journal-market-reading"><h3>Lectura de la lista vigilada</h3><p>${validAssets.length ? `${above} de ${validAssets.length} activos con datos válidos cotizan sobre su media de 200 sesiones. ${above > validAssets.length / 2 ? "Predomina la fuerza de largo plazo en esta lista." : "La fuerza de largo plazo todavía es limitada en esta lista."}` : "Sin cotizaciones suficientes para valorar la tendencia de la lista."} Esta muestra combina distintos activos y no representa la amplitud del mercado completo.</p><p>La tendencia de largo plazo, la confirmación horaria y el filtro diario del índice pueden dar lecturas distintas. Un score alto identifica condiciones técnicas; no es una probabilidad de éxito.</p><small>Cotizaciones: ${escape(marketData?.timestamp || "Sin fecha")} · Periodo del panel: ${escape(marketData?.period || currentPeriod)}. Los niveles de vigilancia no cambian al elegir otro periodo.</small></section>
    <div class="journal-watch-grid">${cards || '<p class="journal-method-note">Todavía no hay activos en vigilancia. Se incorporan al alcanzar la zona Fibonacci o un score de al menos 70 durante una actualización de mercado.</p>'}</div>`;
}

async function loadAndRenderJournal() {
  const container = document.getElementById("journalEntriesContainer");
  if (!container) return;

  try {
    const resp = await fetch("/api/journal");
    if (!resp.ok) throw new Error("Error HTTP " + resp.status);
    const jData = EuroView.convert(await resp.json());

    renderScenarioOverview(jData);
    const allEntries = jData.entries || [];
    const entries = allEntries.filter(e => (e.strategy || "legacy") === journalScenario);
    const stats = jData.scenario_stats?.[journalScenario] || (journalScenario === "legacy" && !jData.scenario_stats ? jData.stats : {}) || {};
    document.querySelector(".journal-kpi-grid")?.toggleAttribute("hidden", journalScenario === "accumulation");
    document.querySelector("#journalSection .journal-toolbar:has(.journal-heading)")?.toggleAttribute("hidden", journalScenario === "accumulation");
    container.hidden = journalScenario === "accumulation";

    const activeEntries = entries.filter(e => ["ACTIVA", "TP1_ALCANZADO"].includes(e.status));
    const closedEntries = entries.filter(e => !["ACTIVA", "TP1_ALCANZADO"].includes(e.status));
    journalVisibleClosedIds = closedEntries.filter(e => !e.archived).map(e => e.id);
    const wonEntries = entries.filter(e => e.result === "GANADA" || ["TP2_ALCANZADO", "BREAKEVEN_EJECUTADO"].includes(e.status));
    const lostEntries = entries.filter(e => e.result === "PERDIDA" || e.status === "STOP_EJECUTADO");

    const elWinRate = document.getElementById("jStatWinRate");
    const elWinRateSub = document.getElementById("jStatWinRateSub");
    const elTotal = document.getElementById("jStatTotal");
    const elActiveSub = document.getElementById("jStatActiveSub");
    const elWon = document.getElementById("jStatWon");
    const elAvgWin = document.getElementById("jStatAvgWin");
    const elLost = document.getElementById("jStatLost");
    const elAvgLoss = document.getElementById("jStatAvgLoss");

    const winRateNum = typeof stats.win_rate_pct === "number" ? stats.win_rate_pct : 0;
    const lossRateNum = (stats.loss_rate_pct !== undefined ? stats.loss_rate_pct : (stats.closed_count ? (stats.total_lost / stats.closed_count * 100) : 0));
    const winRate = winRateNum.toFixed(1);
    const lossRate = lossRateNum.toFixed(1);

    if (elWinRate) {
      elWinRate.textContent = closedEntries.length ? `${winRate}%` : "—";
      elWinRate.className = "j-kpi-val";
      if (elWinRateSub) elWinRateSub.textContent = closedEntries.length
        ? `${wonEntries.length} con beneficio de ${closedEntries.length} cerradas · Incluye archivadas`
        : "Sin señales cerradas todavía";
    }

    if (elTotal) elTotal.textContent = `${stats.total_opportunities || 0}`;
    if (elActiveSub) elActiveSub.textContent = `${stats.active_count || activeEntries.length} activas en seguimiento`;
    if (elWon) elWon.textContent = `${stats.total_won || wonEntries.length}`;
    if (elAvgWin) elAvgWin.textContent = `Ganancia media: +${(stats.avg_win_pct || 0).toFixed(1)}% · ${winRate}% de las cerradas`;
    if (elLost) elLost.textContent = `${stats.total_lost || lostEntries.length}`;
    if (elAvgLoss) {
      const avgLossVal = typeof stats.avg_loss_pct === "number" ? stats.avg_loss_pct : 0;
      elAvgLoss.textContent = `Pérdida media: ${avgLossVal.toFixed(1)}% · ${lossRate}% de las cerradas`;
    }

    const countActiveEl = document.getElementById("jCountActive");
    const countWonEl = document.getElementById("jCountWon");
    const countLostEl = document.getElementById("jCountLost");
    const countClosedEl = document.getElementById("jCountClosed");
    const countAllEl = document.getElementById("jCountAll");
    if (countActiveEl) countActiveEl.textContent = activeEntries.length;
    if (countWonEl) countWonEl.textContent = wonEntries.length;
    if (countLostEl) countLostEl.textContent = lostEntries.length;
    if (countClosedEl) countClosedEl.textContent = closedEntries.length;
    if (countAllEl) countAllEl.textContent = entries.length;

    document.querySelectorAll(".journal-filter-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === journalCurrentFilter);
    });

    const journalBadge = document.getElementById("journalStatsPill");
    if (journalBadge) journalBadge.textContent = closedEntries.length ? `Acierto: ${winRate}%` : "Sin cierres";
    const archivedEntries = closedEntries.filter(entry => entry.archived);
    const archiveCount = document.getElementById("jCountArchived");
    if (archiveCount) archiveCount.textContent = archivedEntries.length;

    let filteredEntries = entries;
    if (journalCurrentFilter === "ACTIVE") {
      filteredEntries = activeEntries;
    } else if (journalCurrentFilter === "WON") {
      filteredEntries = wonEntries;
    } else if (journalCurrentFilter === "LOST") {
      filteredEntries = lostEntries;
    } else if (journalCurrentFilter === "CLOSED") {
      filteredEntries = closedEntries;
    }

    // Los contadores y KPI incluyen el historial completo; las vistas habituales ocultan archivadas.
    if (journalCurrentFilter === "ARCHIVED") filteredEntries = archivedEntries;
    else if (journalCurrentFilter !== "ALL") filteredEntries = filteredEntries.filter(entry => !entry.archived);
    const visibleCounts = { WON: wonEntries, LOST: lostEntries, CLOSED: closedEntries };
    for (const [filter, list] of Object.entries(visibleCounts)) {
      const count = document.getElementById({ WON: "jCountWon", LOST: "jCountLost", CLOSED: "jCountClosed" }[filter]);
      if (count) count.textContent = list.filter(entry => !entry.archived).length;
    }

    if (filteredEntries.length === 0) {
      let emptyMsg = "Aún no hay señales registradas en el diario.";
      if (journalCurrentFilter === "ACTIVE") {
        emptyMsg = "No hay oportunidades activas en seguimiento en este momento.";
      } else if (journalCurrentFilter === "WON") {
        emptyMsg = "Aún no hay señales cerradas con beneficio.";
      } else if (journalCurrentFilter === "LOST") {
        emptyMsg = "Aún no hay señales cerradas con pérdida.";
      } else if (journalCurrentFilter === "CLOSED") {
        emptyMsg = "No hay oportunidades cerradas registradas.";
      }
      if (journalCurrentFilter === "ARCHIVED") emptyMsg = "No hay señales archivadas. Archivar despeja el listado sin borrar resultados.";
      container.innerHTML = `
        <div class="journal-empty-box">
          <p style="font-size: 1.1rem; font-weight: 600; color: #f4efe6; margin-bottom: 8px;">${emptyMsg}</p>
          <p style="font-size: 0.85rem; color: #a89f91; margin: 0;">Las señales se añaden automáticamente con los datos de mercado. El filtro <strong>Todas</strong> incluye también las archivadas.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filteredEntries.map(e => {
      let badgeClass = "j-badge-active";
      let badgeLabel = "🔵 En Seguimiento";
      if (e.status === "TP2_ALCANZADO") {
        badgeClass = "j-badge-won";
        badgeLabel = "🟢 TP2 alcanzado · Cerrada";
      } else if (e.status === "BREAKEVEN_EJECUTADO") {
        badgeClass = "j-badge-breakeven";
        badgeLabel = "🟢 Cerrada · Beneficio parcial en TP1";
      } else if (e.status === "TP1_ALCANZADO") {
        badgeClass = "j-badge-tp1";
        badgeLabel = "🟡 TP1 alcanzado · Stop en la entrada";
      } else if (e.status === "STOP_EJECUTADO") {
        badgeClass = "j-badge-lost";
        badgeLabel = "🔴 Stop Ejecutado";
      }

      const ret = (e.final_return_pct !== null && e.final_return_pct !== undefined)
        ? e.final_return_pct
        : (e.current_return_pct || 0);
      const maxRet = e.max_return_pct || 0;
      const retSign = ret >= 0 ? "+" : "";
      const retColor = ret >= 0 ? "text-green" : "text-red";
      const tvUrl = `https://www.tradingview.com/symbols/${getTradingViewSymbol(e.ticker)}/`;
      const matchedLive = (marketData && marketData.data)
        ? marketData.data.find(it => it.ticker === e.ticker)
        : null;
      const fmtRef = {
        currency: e.currency || (matchedLive && matchedLive.currency) || "$",
        decimals: (typeof e.decimals === "number") ? e.decimals : ((matchedLive && matchedLive.decimals) || 2)
      };
      const originalStop = e.initial_stop_loss ?? (["ACTIVA", "STOP_EJECUTADO"].includes(e.status) ? e.stop_loss : null);
      const isClosed = !["ACTIVA", "TP1_ALCANZADO"].includes(e.status);
      const isWon = e.result === "GANADA" || ["TP2_ALCANZADO", "BREAKEVEN_EJECUTADO"].includes(e.status);

      return `
        <div class="journal-entry-card">
          <div class="j-asset-col">
            <div class="j-asset-header">
              <span class="j-asset-tab">${escapeHtml(e.tab)}</span>
              <span class="j-asset-ticker">${escapeHtml(e.ticker)}</span>
            </div>
            <span class="j-asset-date">📅 Entrada: ${escapeHtml(e.signal_date)}</span>
            ${isClosed && e.closed_date ? `<span class="j-asset-date" style="color: #cbd5e1;">🏁 Cierre: ${escapeHtml(e.closed_date)}</span>` : ""}
            ${!isClosed && e.tp1_hit_date ? `<span class="j-asset-date text-green">🎯 TP1 tocado: ${e.tp1_hit_date}</span>` : ""}
          </div>

          <div class="j-signal-col">
            <span class="j-signal-label">${escapeHtml(e.signal_label)}</span>
            <span class="j-signal-sub">Score inicial: <strong>${e.score}/100</strong> • RSI: ${e.rsi || '--'}</span>
            <span class="j-signal-sub">Periodo registrado: ${escapeHtml(e.period || "No registrado")}</span>
            ${e.exit_reason ? `
              <div class="j-entry-exit-reason ${isWon ? 'j-exit-win' : 'j-exit-loss'}">
                <strong>${isWon ? '🏆 Cierre con beneficio' : '🛑 Cierre con pérdida'}:</strong> ${escapeHtml(e.exit_reason)}
              </div>` : ""}
            ${!isClosed && e.advice ? `
              <div class="j-entry-exit-reason j-exit-info">
                💡 ${escapeHtml(e.advice)}
              </div>` : ""}
          </div>

          <div class="j-prices-col">
            <div class="j-prices-row">
              <span class="j-prices-label">Entrada:</span>
              <span>${formatPrice(e.entry_price, fmtRef)}</span>
            </div>
            <div class="j-prices-row">
              <span class="j-prices-label">Stop original:</span>
              <span>${originalStop !== null ? formatPrice(originalStop, fmtRef) : "No registrado"}</span>
            </div>
            <div class="j-prices-row">
              <span class="j-prices-label">${isClosed ? 'Último stop:' : 'Stop actual:'}</span>
              <span>${formatPrice(e.stop_loss, fmtRef)}</span>
            </div>
            <div class="j-prices-row">
              <span class="j-prices-label">TP1 / TP2:</span>
              <span>${formatPrice(e.tp1, fmtRef)} / ${formatPrice(e.tp2, fmtRef)}</span>
            </div>
            <div class="j-prices-row">
              <span class="j-prices-label">${isClosed ? 'Salida simulada:' : 'Actual:'}</span>
              <span style="font-weight: 700;">${isClosed ? journalExitSummary(e, fmtRef) : formatPrice(e.current_price || e.entry_price, fmtRef)}</span>
            </div>
          </div>

          <div class="j-return-col">
            <span class="j-return-val ${retColor}">${retSign}${ret.toFixed(1)}%</span>
            <span class="j-status-badge ${badgeClass}">${badgeLabel}</span>
            <span style="font-size: 0.68rem; color: #756c60;">Máx: +${maxRet.toFixed(1)}%</span>
            ${isClosed ? `<span class="j-result-pill ${isWon ? 'pill-green' : 'pill-red'}">${isWon ? 'Con beneficio' : 'Con pérdida'}</span>` : ""}
          </div>

          <div class="j-entry-actions">
            <a href="${tvUrl}" target="_blank" class="btn btn-secondary btn-sm" title="Abrir gráfico en TradingView">
              📊 Gráfico
            </a>
            ${e.archived ? '<span class="j-signal-sub">Archivada · Incluida en estadísticas</span>' : ""}
            ${isClosed ? `<button type="button" class="btn btn-secondary btn-sm" data-journal-action="${e.archived ? 'restore' : 'archive'}" data-id="${escapeHtml(e.id)}">${e.archived ? 'Restaurar' : 'Archivar'}</button>` : ""}
            ${isClosed && e.archived ? `<button type="button" class="btn btn-secondary btn-sm btn-danger-soft" data-journal-action="delete" data-id="${escapeHtml(e.id)}">Borrar definitivamente</button>` : ""}
          </div>
        </div>
      `;
    }).join("");

  } catch (err) {
    container.innerHTML = `<div class="journal-empty-box"><p style="color: #f87171;">Error al cargar el diario: ${err.message}</p></div>`;
  }
}

// ==========================================================================
// RENDERIZADOR DEL ÍNDICE CNN FEAR & GREED (WALL STREET SENTIMENT)
// ==========================================================================

function renderMarketSentiment(sentiment) {
  const card = document.getElementById("kpiSentimentCard");
  const elScore = document.getElementById("kpiSentimentScore");
  const elBadge = document.getElementById("kpiSentimentBadge");
  const elIcon = document.getElementById("kpiSentimentIcon");
  const elNeedle = document.getElementById("sentimentGaugeNeedle");
  const elPrev = document.getElementById("kpiSentimentPrev");
  const elAdvice = document.getElementById("kpiSentimentAdvice");

  if (!sentiment) {
    if (elScore) elScore.textContent = "--";
    if (elBadge) elBadge.textContent = "Sin datos";
    return;
  }

  const score = typeof sentiment.score === "number" ? sentiment.score : (parseFloat(sentiment.score) || 50);
  const ratingEs = sentiment.rating_es || "Neutral";
  const icon = sentiment.icon || "😐";

  if (elScore) elScore.textContent = Math.round(score);
  if (elIcon) elIcon.textContent = icon;
  if (elBadge) elBadge.textContent = ratingEs;

  // Actualizar aguja del termómetro (de 2% a 98% para encajar perfecto en el track)
  if (elNeedle) {
    const clampedPos = Math.max(2, Math.min(98, score));
    elNeedle.style.left = `${clampedPos}%`;
  }

  // Comparativa histórica rápida
  if (elPrev) {
    const prevClose = (sentiment.previous_close !== null && sentiment.previous_close !== undefined) ? Math.round(sentiment.previous_close) : "--";
    const prev1w = (sentiment.previous_1_week !== null && sentiment.previous_1_week !== undefined) ? Math.round(sentiment.previous_1_week) : "--";
    elPrev.textContent = `Ayer: ${prevClose} | Hace 1 sem: ${prev1w}`;
  }

  // Consejo estratégico macro
  if (elAdvice) {
    elAdvice.textContent = sentiment.advice || "Analizando el clima de Wall Street...";
  }

  // Clases semafóricas dinámicas
  if (card) {
    card.classList.remove(
      "sentiment-zone-extreme-fear",
      "sentiment-zone-fear",
      "sentiment-zone-neutral",
      "sentiment-zone-greed",
      "sentiment-zone-extreme-greed"
    );

    if (score <= 24) {
      card.classList.add("sentiment-zone-extreme-fear");
    } else if (score <= 44) {
      card.classList.add("sentiment-zone-fear");
    } else if (score <= 55) {
      card.classList.add("sentiment-zone-neutral");
    } else if (score <= 75) {
      card.classList.add("sentiment-zone-greed");
    } else {
      card.classList.add("sentiment-zone-extreme-greed");
    }
  }
}

function openSentimentModal() {
  const modal = document.getElementById("sentimentModal");
  if (!modal) return;
  modal.style.display = "flex";

  const sentiment = (marketData && marketData.market_sentiment) ? marketData.market_sentiment : null;
  if (!sentiment) return;

  const score = Math.round(sentiment.score || 50);
  const ratingEs = sentiment.rating_es || "Neutral";
  const icon = sentiment.icon || "😐";

  const modalIcon = document.getElementById("modalSentimentIcon");
  const modalScore = document.getElementById("modalSentimentScore");
  const modalStatus = document.getElementById("modalSentimentStatus");
  const modalAdvice = document.getElementById("modalSentimentAdvice");

  if (modalIcon) modalIcon.textContent = icon;
  if (modalScore) modalScore.textContent = `${score}/100`;
  if (modalStatus) modalStatus.textContent = ratingEs;
  if (modalAdvice) modalAdvice.textContent = sentiment.advice || "";

  // Historial rápido
  const elPrevClose = document.getElementById("modalHistPrevClose");
  const el1Week = document.getElementById("modalHist1Week");
  const el1Month = document.getElementById("modalHist1Month");
  const el1Year = document.getElementById("modalHist1Year");

  if (elPrevClose) elPrevClose.textContent = sentiment.previous_close !== null ? Math.round(sentiment.previous_close) : "--";
  if (el1Week) el1Week.textContent = sentiment.previous_1_week !== null ? Math.round(sentiment.previous_1_week) : "--";
  if (el1Month) el1Month.textContent = sentiment.previous_1_month !== null ? Math.round(sentiment.previous_1_month) : "--";
  if (el1Year) el1Year.textContent = sentiment.previous_1_year !== null ? Math.round(sentiment.previous_1_year) : "--";

  // Lista de 7 factores cuantitativos
  const listContainer = document.getElementById("sentimentFactorsList");
  if (listContainer && sentiment.sub_indicators) {
    listContainer.innerHTML = "";
    const subs = sentiment.sub_indicators;

    Object.keys(subs).forEach(key => {
      const item = subs[key];
      const val = typeof item.score === "number" ? Math.round(item.score) : item.score;
      const rawRating = (item.rating || "neutral").toLowerCase().replace(/\s+/g, "-");
      const badgeClass = `factor-badge-${rawRating}`;
      const badgeText = item.rating_es || item.rating || "Neutral";

      // Gradiente de barra según nivel
      let barGradient = "linear-gradient(90deg, #9bb8cc, #7f9db3)";
      if (val <= 25) {
        barGradient = "linear-gradient(90deg, #e5604f, #c94d3d)";
      } else if (val <= 45) {
        barGradient = "linear-gradient(90deg, #e0a84e, #c48d3a)";
      } else if (val <= 55) {
        barGradient = "linear-gradient(90deg, #9bb8cc, #7f9db3)";
      } else if (val <= 75) {
        barGradient = "linear-gradient(90deg, #5cc092, #3f9e74)";
      } else {
        barGradient = "linear-gradient(90deg, #ec4899, #db2777)";
      }

      const factorEl = document.createElement("div");
      factorEl.className = "factor-item";
      factorEl.innerHTML = `
        <div class="factor-top-row">
          <span class="factor-name">${item.label || key}</span>
          <div class="factor-badge-group">
            <span class="factor-score-num">${val}/100</span>
            <span class="factor-badge ${badgeClass}">${badgeText}</span>
          </div>
        </div>
        <div class="factor-desc">${item.description || ""}</div>
        <div class="factor-bar-track">
          <div class="factor-bar-fill" style="width: ${Math.max(2, Math.min(100, val))}%; background: ${barGradient};"></div>
        </div>
      `;
      listContainer.appendChild(factorEl);
    });
  }
}

/* ==========================================================================
   MÓDULO 4 (BLOQUE 3): CONTROLADOR DE "💼 MI CARTERA REAL"
   ========================================================================== */

function escapeHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setupPortfolioModalListeners() {
  const btnClosePf = document.getElementById("btnClosePortfolioModal");
  const btnCancelPf = document.getElementById("btnCancelPortfolioModal");
  const btnSubmitPf = document.getElementById("btnSubmitPortfolio");
  const pfTickerInput = document.getElementById("pfTickerInput");

  [btnClosePf, btnCancelPf].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("portfolioModal");
        if (modal) modal.style.display = "none";
      });
    }
  });

  if (pfTickerInput) {
    pfTickerInput.addEventListener("change", () => {
      const t = pfTickerInput.value.trim().toUpperCase();
      const priceInput = document.getElementById("pfAvgPriceInput");
      if (t && priceInput && !priceInput.value && marketData && Array.isArray(marketData.data)) {
        const found = marketData.data.find(it => (it.ticker || "").toUpperCase() === t);
        if (found) {
          priceInput.value = found.current_price;
        }
      }
    });
  }

  if (btnSubmitPf) {
    btnSubmitPf.addEventListener("click", async () => {
      await submitPortfolioAction();
    });
  }

  // Modal de Venta / Cierre de Posición
  const btnClosePfClose = document.getElementById("btnClosePfCloseModal");
  const btnCancelPfClose = document.getElementById("btnCancelPfCloseModal");
  const btnConfirmPfClose = document.getElementById("btnConfirmPfClose");
  const btnDeletePfRaw = document.getElementById("btnDeletePortfolioRaw");
  const pfCloseSharesInput = document.getElementById("pfCloseSharesInput");
  const pfClosePriceInput = document.getElementById("pfClosePriceInput");
  const closePresets = document.querySelectorAll(".btn-pf-close-preset");

  [btnClosePfClose, btnCancelPfClose].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        const modal = document.getElementById("portfolioCloseModal");
        if (modal) modal.style.display = "none";
        currentPortfolioClosePos = null;
      });
    }
  });

  closePresets.forEach(btn => {
    btn.addEventListener("click", () => {
      closePresets.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (!currentPortfolioClosePos || !pfCloseSharesInput) return;
      const pct = parseInt(btn.dataset.pct || "100", 10);
      const total = Number(currentPortfolioClosePos.shares || 0);
      let qty = total * (pct / 100);
      if (pct >= 100) {
        qty = total;
      } else if (Number.isInteger(total) && total >= 4) {
        qty = Math.max(1, Math.round(qty));
      } else {
        qty = parseFloat(qty.toFixed(6));
      }
      pfCloseSharesInput.value = qty;
      updatePfClosePreview();
    });
  });

  [pfCloseSharesInput, pfClosePriceInput].forEach(inp => {
    if (inp) {
      inp.addEventListener("input", () => {
        updatePfClosePreview();
      });
    }
  });

  if (btnConfirmPfClose) {
    btnConfirmPfClose.addEventListener("click", async () => {
      await submitPortfolioCloseAction(false);
    });
  }

  if (btnDeletePfRaw) {
    btnDeletePfRaw.addEventListener("click", async () => {
      if (!currentPortfolioClosePos) return;
      if (confirm(`¿Eliminar ${currentPortfolioClosePos.tab} (${currentPortfolioClosePos.ticker}) de Mi Cartera sin registrar venta en el historial?`)) {
        await submitPortfolioCloseAction(true);
      }
    });
  }
}

function openPortfolioModalForAsset(item) {
  const risk = item.risk_mgmt || {};
  openPortfolioModal({
    ticker: item.ticker,
    input_meta: EuroView.inputMeta(item),
    shares: "",
    avg_price: item.current_price,
    custom_sl: risk.stop_loss || "",
    custom_tp: risk.take_profit_2 || item.max || "",
    notes: "",
    merge: true
  });
}

function openPortfolioModal(prefill = null) {
  const modal = document.getElementById("portfolioModal");
  if (!modal) return;
  const source = prefill?.input_meta ? null : [...(portfolioData?.positions || []), ...(marketData?.data || [])].find(item => item.ticker === prefill?.ticker);
  currentPortfolioInputMeta = prefill?.input_meta || EuroView.inputMeta(source);

  // Poblar datalist de tickers en seguimiento
  const datalist = document.getElementById("pfTrackedTickersList");
  if (datalist && marketData && Array.isArray(marketData.data)) {
    datalist.innerHTML = marketData.data
      .map(it => `<option value="${escapeHtml(it.ticker)}">${escapeHtml(it.tab)} — ${escapeHtml(it.name)}</option>`)
      .join("");
  }

  const isEdit = Boolean(prefill && prefill.isEdit);
  const titleEl = document.getElementById("pfModalTitle");
  const subEl = document.getElementById("pfModalSubtitle");
  const txtSubmit = document.getElementById("txtSubmitPortfolio");
  const tickerInp = document.getElementById("pfTickerInput");
  const sharesInp = document.getElementById("pfSharesInput");
  const priceInp = document.getElementById("pfAvgPriceInput");
  const slInp = document.getElementById("pfCustomSlInput");
  const tpInp = document.getElementById("pfCustomTpInput");
  const notesInp = document.getElementById("pfNotesInput");
  const chkMerge = document.getElementById("chkPfMerge");
  const errBox = document.getElementById("pfModalError");

  if (errBox) {
    errBox.style.display = "none";
    errBox.textContent = "";
  }

  if (titleEl) {
    titleEl.textContent = isEdit
      ? `Editar Posición: ${prefill.ticker}`
      : "Registrar Compra en Mi Cartera";
  }
  if (subEl) {
    subEl.textContent = isEdit
      ? "Ajusta títulos, precio medio, Stop Loss o Take Profit objetivo"
      : "Calcula automáticamente tu precio medio ponderado (DCA), PnL en vivo y alertas SL/TP";
  }
  if (txtSubmit) {
    txtSubmit.textContent = isEdit ? "Actualizar Posición" : "Guardar Posición";
  }

  if (tickerInp) {
    tickerInp.value = (prefill && prefill.ticker) ? prefill.ticker : "";
    tickerInp.readOnly = isEdit;
  }
  if (sharesInp) sharesInp.value = (prefill && prefill.shares !== undefined && prefill.shares !== "") ? prefill.shares : "";
  if (priceInp) priceInp.value = (prefill && prefill.avg_price !== undefined && prefill.avg_price !== "") ? prefill.avg_price : "";
  if (slInp) slInp.value = (prefill && prefill.custom_sl) ? prefill.custom_sl : "";
  if (tpInp) tpInp.value = (prefill && prefill.custom_tp) ? prefill.custom_tp : "";
  if (notesInp) notesInp.value = (prefill && prefill.notes) ? prefill.notes : "";
  if (chkMerge) chkMerge.checked = isEdit ? false : (prefill && prefill.merge !== undefined ? prefill.merge : true);

  modal.style.display = "flex";
  setTimeout(() => {
    if (tickerInp && !tickerInp.value) tickerInp.focus();
    else if (sharesInp) sharesInp.focus();
  }, 80);
}

async function submitPortfolioAction() {
  const tickerInp = document.getElementById("pfTickerInput");
  const sharesInp = document.getElementById("pfSharesInput");
  const priceInp = document.getElementById("pfAvgPriceInput");
  const slInp = document.getElementById("pfCustomSlInput");
  const tpInp = document.getElementById("pfCustomTpInput");
  const notesInp = document.getElementById("pfNotesInput");
  const chkMerge = document.getElementById("chkPfMerge");
  const errBox = document.getElementById("pfModalError");
  const btnSubmit = document.getElementById("btnSubmitPortfolio");

  const parseNum = (v) => parseFloat(String(v || "0").replace(",", "."));
  const ticker = tickerInp ? tickerInp.value.trim().toUpperCase() : "";
  const shares = parseNum(sharesInp ? sharesInp.value : "0");
  const avg_price = parseNum(priceInp ? priceInp.value : "0");
  const custom_sl = slInp && slInp.value.trim() !== "" ? parseNum(slInp.value) : null;
  const custom_tp = tpInp && tpInp.value.trim() !== "" ? parseNum(tpInp.value) : null;
  const notes = notesInp ? notesInp.value.trim() : "";
  const merge = chkMerge ? chkMerge.checked : true;

  const showErr = (m) => {
    if (errBox) {
      errBox.textContent = m;
      errBox.style.display = "block";
    }
  };

  if (!ticker) return showErr("Introduce el símbolo / ticker del activo.");
  if (!shares || shares <= 0) return showErr("Introduce un número de títulos válido mayor que 0.");
  if (!avg_price || avg_price <= 0) return showErr("Introduce un precio de compra válido mayor que 0.");

  try {
    if (btnSubmit) btnSubmit.disabled = true;
    const resp = await fetch("/api/portfolio/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, shares, avg_price, custom_sl, custom_tp, notes, merge, ...currentPortfolioInputMeta })
    });
    const data = await resp.json();
    if (!resp.ok) {
      showErr(data.error || "Error guardando la posición.");
      return;
    }

    portfolioData = EuroView.convert(data);
    renderPortfolioView(portfolioData);
    const modal = document.getElementById("portfolioModal");
    if (modal) modal.style.display = "none";
    showToast(`💼 Posición en ${ticker} guardada en Mi Cartera Real`);
    if (currentAppMode !== "PORTFOLIO") {
      setAppMode("PORTFOLIO");
    }
  } catch (err) {
    showErr("Error de conexión: " + err.message);
  } finally {
    if (btnSubmit) btnSubmit.disabled = false;
  }
}

function openPortfolioCloseModal(pos) {
  currentPortfolioClosePos = pos;
  currentPortfolioCloseInputMeta = EuroView.inputMeta(pos);
  const modal = document.getElementById("portfolioCloseModal");
  if (!modal) return;

  const titleEl = document.getElementById("pfCloseTitle");
  const subEl = document.getElementById("pfCloseSubtitle");
  const sharesInp = document.getElementById("pfCloseSharesInput");
  const priceInp = document.getElementById("pfClosePriceInput");
  const errBox = document.getElementById("pfCloseError");

  if (errBox) {
    errBox.style.display = "none";
    errBox.textContent = "";
  }
  if (titleEl) titleEl.textContent = `Vender / Cerrar: ${pos.tab} (${pos.ticker})`;
  if (subEl) subEl.textContent = `Posición actual: ${pos.shares} títulos @ ${formatPrice(pos.avg_price, pos)} de media`;
  if (sharesInp) sharesInp.value = pos.shares;
  if (priceInp) priceInp.value = pos.current_price;

  document.querySelectorAll(".btn-pf-close-preset").forEach(b => {
    b.classList.toggle("active", b.dataset.pct === "100");
  });

  updatePfClosePreview();
  modal.style.display = "flex";
}

function updatePfClosePreview() {
  const pos = currentPortfolioClosePos;
  const previewEl = document.getElementById("pfClosePreviewText");
  if (!pos || !previewEl) return;

  const sharesInp = document.getElementById("pfCloseSharesInput");
  const priceInp = document.getElementById("pfClosePriceInput");
  const parseNum = (v) => parseFloat(String(v || "0").replace(",", "."));
  const qty = Math.min(Number(pos.shares || 0), Math.max(0, parseNum(sharesInp ? sharesInp.value : "0") || 0));
  const exitP = Math.max(0, parseNum(priceInp ? priceInp.value : "0") || 0);
  const sym = pos.currency || "$";

  if (qty <= 0 || exitP <= 0) {
    previewEl.textContent = "Introduce los títulos y el precio de venta para calcular el beneficio neto.";
    return;
  }

  const cashReceived = qty * exitP;
  const pnlAbs = (exitP - pos.avg_price) * qty;
  const pnlPct = pos.avg_price > 0 ? ((exitP - pos.avg_price) / pos.avg_price) * 100 : 0;
  const sign = pnlAbs >= 0 ? "+" : "-";
  const color = pnlAbs >= 0 ? "#5cc092" : "#fb7185";
  const remaining = Math.max(0, Number(pos.shares) - qty);
  const remText = remaining > 1e-6
    ? `Quedarán <strong>${Number.isInteger(remaining) ? remaining : formatFractionalUnits(remaining)} títulos</strong> abiertos en cartera.`
    : "Se cerrará el <strong>100% de la posición</strong>.";

  previewEl.innerHTML = `Recibirás <strong>${sym}${formatCurrency(cashReceived, 2)}</strong> en efectivo • Resultado realizado: <strong style="color:${color};">${sign}${sym}${formatCurrency(Math.abs(pnlAbs), 2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)</strong>.<br>${remText}`;
}

async function submitPortfolioCloseAction(rawDeleteOnly = false) {
  if (!currentPortfolioClosePos) return;
  const pos = currentPortfolioClosePos;
  const sharesInp = document.getElementById("pfCloseSharesInput");
  const priceInp = document.getElementById("pfClosePriceInput");
  const errBox = document.getElementById("pfCloseError");
  const btnConfirm = document.getElementById("btnConfirmPfClose");

  const parseNum = (v) => parseFloat(String(v || "0").replace(",", "."));
  const sell_shares = rawDeleteOnly ? pos.shares : parseNum(sharesInp ? sharesInp.value : "0");
  const sell_price = rawDeleteOnly ? null : parseNum(priceInp ? priceInp.value : "0");

  if (!rawDeleteOnly && (!sell_shares || sell_shares <= 0 || !sell_price || sell_price <= 0)) {
    if (errBox) {
      errBox.textContent = "Indica una cantidad de títulos y un precio de venta mayores que 0.";
      errBox.style.display = "block";
    }
    return;
  }

  try {
    if (btnConfirm) btnConfirm.disabled = true;
    const resp = await fetch("/api/portfolio/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: pos.ticker, sell_shares, sell_price, ...currentPortfolioCloseInputMeta })
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (errBox) {
        errBox.textContent = data.error || "Error al procesar el cierre.";
        errBox.style.display = "block";
      }
      return;
    }

    portfolioData = EuroView.convert(data);
    renderPortfolioView(portfolioData);
    const modal = document.getElementById("portfolioCloseModal");
    if (modal) modal.style.display = "none";
    currentPortfolioClosePos = null;
    showToast(rawDeleteOnly ? `Posición ${pos.ticker} eliminada.` : `💰 Venta de ${pos.ticker} registrada con éxito`);
  } catch (err) {
    if (errBox) {
      errBox.textContent = "Error de conexión: " + err.message;
      errBox.style.display = "block";
    }
  } finally {
    if (btnConfirm) btnConfirm.disabled = false;
  }
}

async function loadAndRenderPortfolio() {
  try {
    const resp = await fetch("/api/portfolio");
    if (!resp.ok) return;
    const data = await resp.json();
    portfolioData = EuroView.convert(data);
    renderPortfolioView(portfolioData);
  } catch (e) {
    // En modo archivo estático sin servidor Flask/HTTP, ignorar silenciosamente
  }
}

function renderPortfolioView(pf) {
  if (!pf) return;
  const summary = pf.summary || {};
  const positions = pf.positions || [];
  const closed = pf.closed_history || [];

  const curr = summary.primary_currency || "$";
  const count = summary.positions_count || 0;
  const pnlAbs = summary.primary_pnl_abs || 0;
  const pnlPct = summary.primary_pnl_pct || 0;
  const pnlSign = pnlAbs >= 0 ? "+" : "-";

  // Actualizar píldora de la pestaña de navegación superior
  const navPill = document.getElementById("portfolioPnlPill");
  if (navPill) {
    if (count === 0) {
      navPill.textContent = "0 pos.";
      navPill.style.background = "rgba(255, 255, 255, 0.08)";
      navPill.style.color = "#a89f91";
    } else {
      const pSign = pnlPct >= 0 ? "+" : "";
      navPill.textContent = `${count} pos. • ${summary.valuation_incomplete ? "⚠️ Valoración provisional" : pSign + pnlPct.toFixed(1) + "%"}`;
      navPill.style.background = pnlAbs >= 0 ? "rgba(16, 185, 129, 0.22)" : "rgba(244, 63, 94, 0.25)";
      navPill.style.color = pnlAbs >= 0 ? "#6ee7b7" : "#fda4af";
    }
  }

  // Actualizar KPIs de Mi Cartera Real
  const elMarketVal = document.getElementById("pfStatMarketVal");
  const elInvestedSub = document.getElementById("pfStatInvestedSub");
  const elOpenPnl = document.getElementById("pfStatOpenPnl");
  const elOpenPnlPct = document.getElementById("pfStatOpenPnlPct");
  const elPositions = document.getElementById("pfStatPositions");
  const elAlertsSub = document.getElementById("pfStatAlertsSub");
  const elRealized = document.getElementById("pfStatRealizedPnl");
  const elRealizedSub = document.getElementById("pfStatRealizedSub");

  const multiCurrencies = Object.values(summary.totals_by_currency || {});
  const extraBucketsText = multiCurrencies.length > 1
    ? " | " + multiCurrencies
        .filter(b => b.currency !== curr)
        .map(b => `${b.currency}${formatCurrency(b.market_val, 2)}`)
        .join(" + ")
    : "";

  if (elMarketVal) elMarketVal.textContent = `${curr}${formatCurrency(summary.primary_market_val || 0, 2)}`;
  if (elInvestedSub) elInvestedSub.textContent = `Capital invertido: ${curr}${formatCurrency(summary.primary_invested || 0, 2)}${extraBucketsText}`;
  if (elOpenPnl) {
    elOpenPnl.textContent = `${pnlSign}${curr}${formatCurrency(Math.abs(pnlAbs), 2)}`;
    elOpenPnl.className = `j-kpi-val ${pnlAbs >= 0 ? "text-green" : "text-red"}`;
  }
  if (elOpenPnlPct) {
    elOpenPnlPct.textContent = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% (${summary.winners_count || 0} en verde / ${summary.losers_count || 0} en rojo)`;
  }
  if (elPositions) elPositions.textContent = `${count}`;
  if (elAlertsSub) {
    const aCount = summary.alerts_count || 0;
    elAlertsSub.textContent = aCount > 0 ? `🔔 ${aCount} ${aCount === 1 ? "posición requiere atención" : "posiciones requieren atención"}` : "✅ Niveles SL/TP bajo control";
    if (summary.valuation_incomplete) elAlertsSub.textContent = `⚠️ Valoración provisional: ${summary.missing_quotes_count || 0} sin precio, ${summary.stale_quotes_count || 0} desactualizadas. Totales solo de posiciones con precio.`;
  }

  const realizedVal = summary.primary_realized_pnl || 0;
  if (elRealized) {
    const rSign = realizedVal >= 0 ? "+" : "-";
    elRealized.textContent = `${rSign}${curr}${formatCurrency(Math.abs(realizedVal), 2)}`;
    elRealized.className = `j-kpi-val ${realizedVal >= 0 ? "text-green" : "text-red"}`;
  }
  if (elRealizedSub) elRealizedSub.textContent = `${closed.length} ${closed.length === 1 ? "operación cerrada" : "operaciones cerradas"}`;

  if (count > 0 && summary.missing_quotes_count === count) {
    if (elMarketVal) elMarketVal.textContent = "No disponible";
    if (elOpenPnl) elOpenPnl.textContent = "No disponible";
    if (elOpenPnlPct) elOpenPnlPct.textContent = "Sin cotizaciones para valorar la cartera";
  }

  // Renderizar tarjetas de posiciones abiertas
  const container = document.getElementById("portfolioPositionsContainer");
  if (!container) return;

  if (positions.length === 0) {
    container.innerHTML = `
      <div class="journal-empty-box" style="grid-column: 1 / -1;">
        <div style="font-size: 2.2rem; margin-bottom: 8px;">💼</div>
        <p style="font-size: 1.1rem; font-weight: 600; color: #f4efe6; margin-bottom: 8px;">Tu Cartera Real está vacía</p>
        <p style="font-size: 0.86rem; color: #a89f91; max-width: 560px; margin: 0 auto 16px;">
          Registra tus compras reales (acciones enteras o fracciones cripto) para vigilar en tiempo real tu <strong>precio medio ponderado</strong>, <strong>PnL abierto</strong>, distancia a <strong>Stop Loss / Take Profit</strong> y avisos de resultados.
        </p>
        <button type="button" class="btn btn-emerald btn-sm" id="btnEmptyPortfolioAdd">+ Registrar Primera Posición</button>
      </div>
    `;
    const btnEmpty = document.getElementById("btnEmptyPortfolioAdd");
    if (btnEmpty) btnEmpty.addEventListener("click", () => openPortfolioModal());
  } else {
    container.innerHTML = "";
    positions.forEach(pos => {
      const card = document.createElement("article");
      card.className = `portfolio-pos-card ${pos.has_action_alert ? "pf-has-alert" : ""}`;
      const sym = pos.currency || "$";
      const isProfit = pos.pnl_abs >= 0;
      const pSign = isProfit ? "+" : "-";
      const sharesFmt = Number.isInteger(pos.shares) ? `${pos.shares}` : formatFractionalUnits(pos.shares);

      let statusCls = "pf-badge-neutral";
      if (pos.status_code === "STOP_ALERT") statusCls = "pf-badge-danger";
      else if (pos.status_code === "TP_REACHED" || pos.status_code === "IN_PROFIT") statusCls = "pf-badge-profit";
      else if (pos.status_code === "TAKE_PARTIAL" || pos.status_code === "MOVE_BE") statusCls = "pf-badge-warn";
      else if (pos.status_code === "DCA_ZONE") statusCls = "pf-badge-gold";

      const earnHtml = (pos.earnings && (pos.earnings.warning_level === "IMMINENT" || pos.earnings.warning_level === "UPCOMING") && pos.earnings.label)
        ? `<span class="earnings-pill ${pos.earnings.warning_level === "IMMINENT" ? "earnings-imminent" : "earnings-upcoming"}">${escapeHtml(pos.earnings.label)}</span>`
        : "";

      const notesHtml = pos.notes
        ? `<div class="pf-notes-line">📝 ${escapeHtml(pos.notes)}</div>`
        : "";

      card.innerHTML = `
        <div class="pf-card-header">
          <div>
            <div class="pf-title-row">
              <span class="pf-tab-name">${escapeHtml(pos.tab)}</span>
              <span class="asset-ticker">${escapeHtml(pos.ticker)}</span>
              ${pos.tx_count > 1 ? `<span class="pf-dca-tag" title="Precio medio de ${pos.tx_count} compras">${pos.tx_count} compras</span>` : ""}
            </div>
            <div class="pf-company-sub">${escapeHtml(pos.name)}</div>
          </div>
          <div class="pf-badges-col">
            <span class="pf-status-badge ${statusCls}">${escapeHtml(pos.status_badge)}</span>
            ${earnHtml}
          </div>
        </div>

        <div class="pf-metrics-grid">
          <div class="pf-metric-box">
            <span class="pf-m-label">Posición & Entrada Media</span>
            <span class="pf-m-val">${sharesFmt} tít. @ ${formatPrice(pos.avg_price, pos)}</span>
            <span class="pf-m-sub">Invertido: ${sym}${formatCurrency(pos.invested_val, 2)}</span>
          </div>
          <div class="pf-metric-box">
            <span class="pf-m-label">Cotización & Valor Actual</span>
            <span class="pf-m-val">${formatPrice(pos.current_price, pos)}</span>
            <span class="pf-m-sub">Valor: ${sym}${formatCurrency(pos.market_val, 2)}</span>
          </div>
          <div class="pf-metric-box ${isProfit ? "pf-box-profit" : "pf-box-loss"}">
            <span class="pf-m-label">PnL Abierto (Latente)</span>
            <span class="pf-m-val ${pos.pnl_abs == null ? "" : isProfit ? "text-green" : "text-red"}">${pos.pnl_abs == null ? "No disponible" : pSign + sym + formatCurrency(Math.abs(pos.pnl_abs), 2)}</span>
            <span class="pf-m-sub">${pos.pnl_pct == null ? "Sin cotización" : (pos.pnl_pct >= 0 ? "+" : "") + pos.pnl_pct.toFixed(2) + "%"}</span>
          </div>
        </div>

        <div class="pf-gauge-box" ${pos.has_quote === false ? 'hidden' : ''}>
          <div class="pf-gauge-labels">
            <span class="val-danger" title="Fuente: ${escapeHtml(pos.sl_source)}">🛡️ SL: ${formatPrice(pos.effective_sl, pos)} (${pos.dist_to_sl_pct >= 0 ? "-" : "+"}${Math.abs(pos.dist_to_sl_pct).toFixed(1)}%)</span>
            <span style="color:#cfc6b8;">📍 Entrada: ${formatPrice(pos.avg_price, pos)}</span>
            <span class="val-success" title="Fuente: ${escapeHtml(pos.tp_source)}">🎯 TP: ${formatPrice(pos.effective_tp, pos)} (+${pos.dist_to_tp_pct.toFixed(1)}%)</span>
          </div>
          <div class="pf-progress-track">
            <div class="pf-progress-fill ${isProfit ? "fill-profit" : "fill-drawdown"}" style="width: ${pos.progress_pct}%;"></div>
            <div class="pf-entry-marker" style="left: ${pos.entry_marker_pct}%;" title="Precio medio de entrada: ${formatPrice(pos.avg_price, pos)}"></div>
            <div class="pf-current-pin" style="left: ${pos.progress_pct}%;" title="Precio actual: ${formatPrice(pos.current_price, pos)}"></div>
          </div>
        </div>

        <div class="pf-advice-box">
          <span>💡 ${escapeHtml(pos.advice)}</span>
          ${notesHtml}
        </div>

        <div class="pf-card-actions">
          <button type="button" class="btn btn-secondary btn-sm btn-pf-dca" title="Añadir más títulos y recalcular precio medio (DCA)">➕ Promediar</button>
          <button type="button" class="btn btn-secondary btn-sm btn-pf-edit" title="Editar Stop Loss, Take Profit, títulos o notas">✏️ Editar SL/TP</button>
          <button type="button" class="btn btn-emerald btn-sm btn-pf-sell" title="Registrar venta parcial o cierre total">💰 Vender / Cerrar</button>
          <button type="button" class="btn btn-secondary btn-sm btn-pf-chart" title="Abrir gráfico avanzado">📊</button>
        </div>
      `;

      card.querySelector(".btn-pf-dca").addEventListener("click", () => {
        openPortfolioModal({
          ticker: pos.ticker,
          shares: "",
          input_meta: EuroView.inputMeta(pos),
          avg_price: pos.current_price,
          custom_sl: pos.custom_sl || "",
          custom_tp: pos.custom_tp || "",
          notes: pos.notes || "",
          merge: true
        });
      });

      card.querySelector(".btn-pf-edit").addEventListener("click", () => {
        openPortfolioModal({
          isEdit: true,
          ticker: pos.ticker,
          shares: pos.shares,
          input_meta: EuroView.inputMeta(pos),
          avg_price: pos.avg_price,
          custom_sl: pos.custom_sl || "",
          custom_tp: pos.custom_tp || "",
          notes: pos.notes || "",
          merge: false
        });
      });

      card.querySelector(".btn-pf-sell").addEventListener("click", () => {
        openPortfolioCloseModal(pos);
      });

      card.querySelector(".btn-pf-chart").addEventListener("click", () => {
        openFullscreenChart(pos.ticker, pos.tab);
      });

      container.appendChild(card);
    });
  }

  // Renderizar historial de ventas cerradas si existen
  const closedWrap = document.getElementById("portfolioClosedWrapper");
  const closedList = document.getElementById("portfolioClosedContainer");
  if (closedWrap && closedList) {
    if (closed.length === 0) {
      closedWrap.style.display = "none";
    } else {
      closedWrap.style.display = "block";
      closedList.innerHTML = closed.slice(0, 10).map(ch => {
        const s = ch.currency || "$";
        const win = (ch.realized_pnl_abs || 0) >= 0;
        const sign = win ? "+" : "-";
        const shFmt = Number.isInteger(ch.shares_closed) ? ch.shares_closed : formatFractionalUnits(ch.shares_closed);
        return `
          <div class="pf-closed-row">
            <div>
              <strong>${escapeHtml(ch.tab || ch.ticker)}</strong> <span class="asset-ticker">${escapeHtml(ch.ticker)}</span>
              <span class="pf-closed-type">${escapeHtml(ch.close_type || "VENTA")}</span>
            </div>
            <div class="pf-closed-mid">${shFmt} tít. • Entrada ${formatPrice(ch.avg_entry, ch)} → Salida ${formatPrice(ch.exit_price, ch)}</div>
            <div class="pf-closed-pnl ${win ? "text-green" : "text-red"}">${sign}${s}${formatCurrency(Math.abs(ch.realized_pnl_abs || 0), 2)} (${ch.realized_pnl_pct >= 0 ? "+" : ""}${(ch.realized_pnl_pct || 0).toFixed(2)}%)</div>
            <div class="pf-closed-date">${escapeHtml(ch.closed_at || "")}</div>
          </div>
        `;
      }).join("");
    }
  }
}


