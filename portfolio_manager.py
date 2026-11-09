"""
portfolio_manager.py
Gestor de 'Mi Cartera Real' para el proyecto 'Buscar un buen precio'.
Permite registrar compras reales (acciones enteras o fraccionadas), calcular precio medio ponderado,
evaluar PnL abierto en vivo frente a latest_data.json, monitorizar distancia a Stop Loss / Take Profit
y registrar ventas parciales o cierres con historial de beneficio realizado.
"""

import json
import math
import os
import threading
import time
from datetime import datetime

DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PORTFOLIO_PATH = os.path.join(DIRECTORY, "portfolio.json")
LATEST_DATA_PATH = os.path.join(DIRECTORY, "latest_data.json")

PORTFOLIO_LOCK = threading.Lock()


def _default_portfolio():
    return {
        "version": "1.0",
        "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "positions": [],
        "closed_history": []
    }


def _atomic_write(path, data):
    temp_path = f"{path}.{threading.get_ident()}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(temp_path, path)
    except Exception:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
        raise


def load_portfolio():
    if not os.path.exists(PORTFOLIO_PATH):
        return _default_portfolio()
    try:
        with open(PORTFOLIO_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not isinstance(data, dict):
                return _default_portfolio()
            data.setdefault("positions", [])
            data.setdefault("closed_history", [])
            return data
    except Exception as e:
        print(f"[Portfolio] Error leyendo portfolio.json: {e}")
        return _default_portfolio()


def save_portfolio(data):
    data["last_updated"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _atomic_write(PORTFOLIO_PATH, data)


def upsert_position(
    ticker,
    shares,
    avg_price,
    tab="",
    name="",
    currency="$",
    decimals=2,
    custom_sl=None,
    custom_tp=None,
    notes="",
    merge=True
):
    """
    Crea o actualiza una posición real en cartera.
    Si merge=True y el ticker ya existe, acumula los títulos y recalcula el precio medio ponderado.
    Si merge=False, sobrescribe los valores directamente (modo edición).
    """
    t = str(ticker or "").strip().upper()
    if not t:
        raise ValueError("El ticker es obligatorio.")

    qty = float(shares or 0)
    price = float(avg_price or 0)
    if qty <= 0:
        raise ValueError("El número de títulos debe ser mayor que cero.")
    if price <= 0:
        raise ValueError("El precio de entrada debe ser mayor que cero.")

    dec = int(decimals or 2)
    sl_val = round(float(custom_sl), dec) if custom_sl not in (None, "", 0, "0") and float(custom_sl) > 0 else None
    tp_val = round(float(custom_tp), dec) if custom_tp not in (None, "", 0, "0") and float(custom_tp) > 0 else None
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with PORTFOLIO_LOCK:
        pf = load_portfolio()
        positions = pf.get("positions", [])

        existing_idx = next((i for i, p in enumerate(positions) if p.get("ticker", "").upper() == t), None)

        if existing_idx is not None:
            pos = positions[existing_idx]
            if merge:
                old_qty = float(pos.get("shares", 0))
                old_avg = float(pos.get("avg_price", price))
                total_qty = old_qty + qty
                weighted_avg = ((old_qty * old_avg) + (qty * price)) / total_qty
                pos["shares"] = round(total_qty, 6)
                pos["avg_price"] = round(weighted_avg, dec)
                pos["tx_count"] = int(pos.get("tx_count", 1)) + 1
            else:
                pos["shares"] = round(qty, 6)
                pos["avg_price"] = round(price, dec)

            if tab:
                pos["tab"] = tab
            if name:
                pos["name"] = name
            if currency:
                pos["currency"] = currency
            pos["decimals"] = dec

            # En modo edición (merge=False) permitimos limpiar custom_sl/tp si vienen vacíos
            if not merge:
                pos["custom_sl"] = sl_val
                pos["custom_tp"] = tp_val
                pos["notes"] = str(notes or "").strip()
            else:
                if sl_val is not None:
                    pos["custom_sl"] = sl_val
                if tp_val is not None:
                    pos["custom_tp"] = tp_val
                if notes:
                    pos["notes"] = str(notes).strip()

            pos["updated_at"] = now_str
            positions[existing_idx] = pos
        else:
            new_pos = {
                "id": f"pos_{t}_{int(time.time())}",
                "ticker": t,
                "tab": tab or t,
                "name": name or tab or t,
                "currency": currency or "$",
                "decimals": dec,
                "shares": round(qty, 6),
                "avg_price": round(price, dec),
                "custom_sl": sl_val,
                "custom_tp": tp_val,
                "notes": str(notes or "").strip(),
                "tx_count": 1,
                "opened_at": now_str,
                "updated_at": now_str
            }
            positions.insert(0, new_pos)

        pf["positions"] = positions
        save_portfolio(pf)
        return pf


def remove_or_reduce_position(ticker, sell_shares=None, sell_price=None):
    """
    Elimina una posición completa o vende parcialmente una fracción/cantidad de títulos.
    Si se proporciona sell_price, registra la operación cerrada en closed_history con su PnL realizado.
    """
    t = str(ticker or "").strip().upper()
    if not t:
        raise ValueError("Ticker vacío.")

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with PORTFOLIO_LOCK:
        pf = load_portfolio()
        positions = pf.get("positions", [])
        idx = next((i for i, p in enumerate(positions) if p.get("ticker", "").upper() == t), None)
        if idx is None:
            raise ValueError(f"No existe posición abierta para '{t}'.")

        pos = positions[idx]
        curr_qty = float(pos.get("shares", 0))
        avg_p = float(pos.get("avg_price", 0))
        dec = int(pos.get("decimals", 2))

        qty_to_close = curr_qty if sell_shares in (None, "", 0) else float(sell_shares)
        if qty_to_close <= 0:
            raise ValueError("La cantidad a cerrar debe ser mayor que cero.")

        is_full_close = qty_to_close >= (curr_qty - 1e-7)
        actual_closed_qty = curr_qty if is_full_close else qty_to_close

        if sell_price not in (None, "", 0):
            sp = float(sell_price)
            if sp > 0:
                realized_abs = round((sp - avg_p) * actual_closed_qty, 2)
                realized_pct = round(((sp - avg_p) / avg_p) * 100, 2) if avg_p > 0 else 0.0
                pf.setdefault("closed_history", []).insert(0, {
                    "ticker": t,
                    "tab": pos.get("tab", t),
                    "currency": pos.get("currency", "$"),
                    "decimals": dec,
                    "shares_closed": round(actual_closed_qty, 6),
                    "avg_entry": round(avg_p, dec),
                    "exit_price": round(sp, dec),
                    "realized_pnl_abs": realized_abs,
                    "realized_pnl_pct": realized_pct,
                    "close_type": "TOTAL" if is_full_close else "PARCIAL",
                    "closed_at": now_str
                })
                # Conservar todas las ventas: el PnL realizado se calcula
                # sobre este historial, también para cierres parciales.

        if is_full_close:
            positions.pop(idx)
        else:
            pos["shares"] = round(curr_qty - actual_closed_qty, 6)
            pos["updated_at"] = now_str
            positions[idx] = pos

        pf["positions"] = positions
        save_portfolio(pf)
        return pf


def get_enriched_portfolio(market_items=None):
    """
    Cruza las posiciones abiertas en portfolio.json con los precios e indicadores vivos de latest_data.json.
    """
    pf = load_portfolio()
    positions = pf.get("positions", [])
    closed_history = pf.get("closed_history", [])

    if market_items is None:
        market_items = []
        if os.path.exists(LATEST_DATA_PATH):
            try:
                with open(LATEST_DATA_PATH, "r", encoding="utf-8") as f:
                    payload = json.load(f)
                    market_items = payload.get("data", [])
            except Exception:
                market_items = []

    market_by_ticker = {str(it.get("ticker", "")).upper(): it for it in market_items}

    enriched_positions = []
    totals_by_currency = {}
    winners_count = 0
    losers_count = 0
    alerts_count = 0
    missing_quotes = 0
    stale_quotes = 0

    for pos in positions:
        t = str(pos.get("ticker", "")).upper()
        live = market_by_ticker.get(t, {})

        curr_sym = live.get("currency") or pos.get("currency", "$")
        dec = int(live.get("decimals") if live.get("decimals") is not None else pos.get("decimals", 2))
        shares = float(pos.get("shares", 0))
        avg_price = float(pos.get("avg_price", 0))
        try:
            quote = float(live.get("current_price"))
            has_quote = math.isfinite(quote) and quote > 0
        except (TypeError, ValueError):
            has_quote = False
        is_stale = bool(live.get("is_stale"))
        missing_quotes += int(not has_quote)
        stale_quotes += int(has_quote and is_stale)
        # El valor de entrada solo permite construir los niveles; nunca se publica
        # como cotización ni se incluye en la valoración si falta el precio.
        current_price = quote if has_quote else avg_price

        invested_val = round(shares * avg_price, 2)
        market_val = round(shares * current_price, 2)
        pnl_abs = round(market_val - invested_val, 2)
        pnl_pct = round(((current_price - avg_price) / avg_price) * 100, 2) if avg_price > 0 else 0.0

        if has_quote and pnl_abs >= 0:
            winners_count += 1
        elif has_quote:
            losers_count += 1

        risk = live.get("risk_mgmt", {})
        sell = live.get("sell_mgmt", {})
        fibs = live.get("fib_levels", {})

        # Stop Loss efectivo: personalizado del usuario o automático (ATR / Fibonacci)
        if pos.get("custom_sl") and float(pos["custom_sl"]) > 0:
            effective_sl = round(float(pos["custom_sl"]), dec)
            sl_source = "Personalizado"
        else:
            auto_sl = risk.get("atr_stop_loss") or risk.get("stop_loss") or (avg_price * 0.93)
            # Si compramos muy por encima o debajo del nivel sugerido actual, adaptar si auto_sl >= avg_price y estamos en pérdidas
            if auto_sl >= avg_price and current_price <= avg_price:
                auto_sl = min(auto_sl, avg_price * 0.94)
            effective_sl = round(float(auto_sl), dec)
            sl_source = "Auto (ATR/Fibo)"

        # Take Profit efectivo: personalizado del usuario o máximo / extensión
        if pos.get("custom_tp") and float(pos["custom_tp"]) > 0:
            effective_tp = round(float(pos["custom_tp"]), dec)
            tp_source = "Personalizado"
        else:
            base_tp = risk.get("take_profit_2") or live.get("max") or (avg_price * 1.15)
            if base_tp <= avg_price * 1.02:
                base_tp = sell.get("ext_127") or (avg_price * 1.15)
            effective_tp = round(float(base_tp), dec)
            tp_source = "Auto (Máx/Ext)"

        trailing_stop = round(float(sell.get("atr_trailing_stop") or sell.get("trailing_stop") or (current_price * 0.945)), dec)

        dist_to_sl_pct = round(((current_price - effective_sl) / current_price) * 100, 2) if current_price > 0 else 0.0
        dist_to_tp_pct = round(((effective_tp - current_price) / current_price) * 100, 2) if current_price > 0 else 0.0
        pnl_at_sl_abs = round((effective_sl - avg_price) * shares, 2)
        pnl_at_tp_abs = round((effective_tp - avg_price) * shares, 2)

        # Barra de progreso entre Stop Loss (0%) y Take Profit (100%)
        span = effective_tp - effective_sl
        if span > 0:
            progress_pct = max(0.0, min(100.0, round(((current_price - effective_sl) / span) * 100, 1)))
            entry_marker_pct = max(0.0, min(100.0, round(((avg_price - effective_sl) / span) * 100, 1)))
        else:
            progress_pct = 50.0
            entry_marker_pct = 50.0

        sell_score = int(sell.get("sell_score", 0))
        rsi = live.get("rsi")
        earnings = live.get("earnings") or {}

        # Diagnóstico inteligente de gestión de posición abierta
        has_action_alert = False
        if current_price <= effective_sl:
            status_code = "STOP_ALERT"
            status_badge = "🚨 Bajo Stop Loss"
            advice = f"Valora vender para limitar el daño: el precio ha alcanzado o bajado de tu límite de pérdida y tu resultado desde la compra es {pnl_pct:+.1f}%."
            has_action_alert = True
        elif current_price >= effective_tp:
            status_code = "TP_REACHED"
            status_badge = "🏆 Objetivo Alcanzado"
            advice = f"Valora recoger beneficios: has alcanzado tu objetivo y ganas un {pnl_pct:.1f}% desde la compra; puedes vender una parte y revisar el límite de salida del resto."
            has_action_alert = True
        elif pnl_pct > 0 and (
            sell_score >= 65
            or (isinstance(rsi, (int, float)) and rsi >= 64)
            or (0 <= sell.get("dist_to_high_pct", 100) <= 3.5)
            or (avg_price < float(risk.get("take_profit_1") or 0) <= current_price)
        ):
            status_code = "TAKE_PARTIAL"
            status_badge = "🟠 Valorar vender una parte"
            if avg_price < float(risk.get("take_profit_1") or 0) <= current_price:
                reason = "el precio ya ha alcanzado la primera resistencia calculada"
            elif sell_score >= 65 or (isinstance(rsi, (int, float)) and rsi >= 64):
                reason = "los indicadores muestran una subida exigente que podría frenarse"
            else:
                reason = "el precio está a menos de un 3,5% del máximo del periodo"
            advice = f"Valora vender una parte: llevas un +{pnl_pct:.1f}% desde tu compra y {reason}; no necesitas esperar al objetivo final para recoger beneficios."
            has_action_alert = True
        elif pnl_pct >= 7.0 and effective_sl < avg_price * 0.998:
            status_code = "MOVE_BE"
            status_badge = "🛡️ Mantener protegiendo la ganancia"
            advice = f"Puedes seguir esperando, pero protege lo ganado: llevas un +{pnl_pct:.1f}% y tu límite de pérdida sigue por debajo de lo que pagaste; valora subirlo al precio de compra, aunque no garantiza salir sin pérdidas."
            has_action_alert = True
        elif pnl_pct > 0:
            status_code = "IN_PROFIT"
            status_badge = "🟢 En Beneficio"
            advice = f"Puedes mantener por ahora: ganas un {pnl_pct:.1f}% desde tu compra y no se activa una señal de recogida de beneficios; al objetivo le falta un {max(0, dist_to_tp_pct):.1f}%, pero no hay garantía de alcanzarlo."
        else:
            fib_61 = fibs.get("61.8%", 0)
            if fib_61 and current_price <= fib_61 and (live.get("score", 0) >= 70):
                status_code = "DCA_ZONE"
                status_badge = "💎 En Zona Áurea (DCA)"
                advice = f"Espera a que el precio se estabilice antes de decidir: pierdes un {abs(pnl_pct):.1f}% y estás en una zona de posible apoyo; eso no confirma que vaya a rebotar ni justifica comprar más por sí solo."
            else:
                status_code = "DRAWDOWN"
                status_badge = "🔵 En Retroceso Controlado"
                advice = f"Vigila antes de decidir vender: tu resultado es {pnl_pct:+.1f}% y el precio está un {dist_to_sl_pct:.1f}% por encima de tu límite de pérdida."

        # Una resistencia intermedia puede justificar revisar una ganancia antes
        # del objetivo final; nunca reemplaza el TP elegido por el usuario.
        first_target = float(risk.get("take_profit_1") or 0)
        if status_code in ("MOVE_BE", "IN_PROFIT") and current_price < first_target < effective_tp:
            first_distance = (first_target / current_price - 1) * 100
            if first_distance <= 3.5:
                advice += f" La primera resistencia está a solo un {first_distance:.1f}%; si la subida se frena allí, valora vender una parte."

        if earnings.get("warning_level") == "IMMINENT":
            has_action_alert = True
            advice = f"{earnings.get('label', '⚠️ Resultados próximos')} — {advice}"

        if not has_quote or is_stale:
            status_code = "STALE_QUOTE" if has_quote else "NO_QUOTE"
            status_badge = "⚠️ Cotización desactualizada" if has_quote else "⚠️ Sin cotización"
            advice = "Último precio válido; valoración provisional. Actualiza los datos." if has_quote else "Sin precio disponible. Esta posición no se incluye en la valoración ni en el PnL agregado."
            has_action_alert = False

        if has_action_alert:
            alerts_count += 1

        bucket = totals_by_currency.setdefault(curr_sym, {
            "currency": curr_sym,
            "invested": 0.0,
            "market_val": 0.0,
            "pnl_abs": 0.0,
            "pnl_pct": 0.0,
            "positions": 0
        })
        if has_quote:
            bucket["invested"] = round(bucket["invested"] + invested_val, 2)
            bucket["market_val"] = round(bucket["market_val"] + market_val, 2)
            bucket["pnl_abs"] = round(bucket["pnl_abs"] + pnl_abs, 2)
            bucket["positions"] += 1

        enriched_positions.append({
            **pos,
            "tab": live.get("tab") or pos.get("tab") or t,
            "name": live.get("name") or pos.get("name") or t,
            "currency": curr_sym,
            "decimals": dec,
            "is_tracked": bool(live),
            "has_quote": has_quote,
            "is_stale": is_stale,
            "last_success_at": live.get("last_success_at"),
            "current_price": round(current_price, dec) if has_quote else None,
            "invested_val": invested_val,
            "market_val": market_val if has_quote else None,
            "pnl_abs": pnl_abs if has_quote else None,
            "pnl_pct": pnl_pct if has_quote else None,
            "effective_sl": effective_sl,
            "sl_source": sl_source,
            "dist_to_sl_pct": dist_to_sl_pct,
            "pnl_at_sl_abs": pnl_at_sl_abs,
            "effective_tp": effective_tp,
            "tp_source": tp_source,
            "dist_to_tp_pct": dist_to_tp_pct,
            "pnl_at_tp_abs": pnl_at_tp_abs,
            "trailing_stop": trailing_stop,
            "progress_pct": progress_pct,
            "entry_marker_pct": entry_marker_pct,
            "score": live.get("score", 0),
            "sell_score": sell_score,
            "rsi": rsi,
            "earnings": earnings,
            "status_code": status_code,
            "status_badge": status_badge,
            "has_action_alert": has_action_alert,
            "advice": advice
        })

    for sym, b in totals_by_currency.items():
        inv = b["invested"]
        b["pnl_pct"] = round((b["pnl_abs"] / inv) * 100, 2) if inv > 0 else 0.0

    # Seleccionar divisa principal (la de mayor capital invertido, o '$' por defecto)
    if totals_by_currency:
        primary_bucket = max(totals_by_currency.values(), key=lambda x: x["invested"])
    else:
        primary_bucket = {"currency": "$", "invested": 0.0, "market_val": 0.0, "pnl_abs": 0.0, "pnl_pct": 0.0}

    realized_by_currency = {}
    for ch in closed_history:
        cs = ch.get("currency", "$")
        realized_by_currency[cs] = round(realized_by_currency.get(cs, 0.0) + float(ch.get("realized_pnl_abs", 0.0)), 2)

    primary_curr = primary_bucket["currency"]
    summary = {
        "positions_count": len(enriched_positions),
        "missing_quotes_count": missing_quotes,
        "stale_quotes_count": stale_quotes,
        "valuation_incomplete": bool(missing_quotes or stale_quotes),
        "winners_count": winners_count,
        "losers_count": losers_count,
        "alerts_count": alerts_count,
        "primary_currency": primary_curr,
        "primary_invested": primary_bucket["invested"],
        "primary_market_val": primary_bucket["market_val"],
        "primary_pnl_abs": primary_bucket["pnl_abs"],
        "primary_pnl_pct": primary_bucket["pnl_pct"],
        "primary_realized_pnl": realized_by_currency.get(primary_curr, 0.0),
        "totals_by_currency": totals_by_currency,
        "realized_by_currency": realized_by_currency
    }

    return {
        "version": pf.get("version", "1.0"),
        "last_updated": pf.get("last_updated"),
        "summary": summary,
        "positions": enriched_positions,
        "closed_history": closed_history
    }

