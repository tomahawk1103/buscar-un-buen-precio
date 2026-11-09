"""Valoración de posiciones con datos simulados, sin operar la cartera real."""
import unittest
from unittest.mock import patch

import portfolio_manager as portfolio


class PositionAdviceTests(unittest.TestCase):
    def evaluate(self, price=273.75, **changes):
        live = {
            "ticker": "CEG", "current_price": price, "rsi": 54.8,
            "risk_mgmt": {"stop_loss": 230.36, "take_profit_1": 274.85,
                          "take_profit_2": 301.77},
            "sell_mgmt": {"sell_score": 8, "dist_to_high_pct": 9.29},
        }
        live.update(changes)
        saved = {"positions": [{"ticker": "CEG", "shares": 1,
                                "avg_price": 252.61}], "closed_history": []}
        with patch.object(portfolio, "load_portfolio", return_value=saved):
            return portfolio.get_enriched_portfolio([live])["positions"][0]

    def test_gain_with_nearby_resistance_explains_wait_and_protection(self):
        position = self.evaluate()
        self.assertEqual(position["status_code"], "MOVE_BE")
        self.assertIn("+8.4%", position["advice"])
        self.assertIn("0.4%", position["advice"])
        self.assertIn("no garantiza", position["advice"])

    def test_first_resistance_can_prompt_partial_without_overbought(self):
        position = self.evaluate(price=275)
        self.assertEqual(position["status_code"], "TAKE_PARTIAL")
        self.assertIn("primera resistencia", position["advice"])

    def test_no_partial_when_resistance_below_purchase(self):
        position = self.evaluate(price=254, risk_mgmt={
            "stop_loss": 240, "take_profit_1": 250, "take_profit_2": 300})
        self.assertEqual(position["status_code"], "IN_PROFIT")

    def test_stop_and_final_target_take_priority(self):
        self.assertEqual(self.evaluate(price=220)["status_code"], "STOP_ALERT")
        self.assertEqual(self.evaluate(price=305)["status_code"], "TP_REACHED")

    def test_stale_or_missing_quote_suppresses_recommendation(self):
        for changes, expected in [({"is_stale": True}, "STALE_QUOTE"),
                                  ({"current_price": None}, "NO_QUOTE")]:
            position = self.evaluate(**changes)
            self.assertEqual(position["status_code"], expected)
            self.assertFalse(position["has_action_alert"])


if __name__ == "__main__":
    unittest.main()
