No problem. Here's the updated server.js with Supabase token storage. Copy this entire file and deploy it to Render:
javascriptconst express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments.production,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.post("/api/create-link-token", async (req, res) => {
  try {
    const userId = req.body.userId || "default-user";
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Petal Finance",
      products: ["transactions"],
      country_codes: ["CA"],
      language: "en",
      webhook: `${process.env.WEBHOOK_URL || "https://petal-finance-backend.onrender.com"}/webhook`,
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

app.post("/api/exchange-token", async (req, res) => {
  try {
    const { public_token, userId, institutionName } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const { data, error } = await supabase.from("plaid_tokens").insert({
      user_id: userId,
      access_token,
      institution_name: institutionName || "Unknown",
    }).select();
    if (error) throw error;
    res.json({ access_token, id: data[0].id });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

app.post("/api/get-tokens", async (req, res) => {
  try {
    const { userId } = req.body;
    const { data, error } = await supabase.from("plaid_tokens").select("*").eq("user_id", userId);
    if (error) throw error;
    res.json({ tokens: data });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to get tokens" });
  }
});

app.post("/api/delete-token", async (req, res) => {
  try {
    const { userId, tokenId } = req.body;
    const { error } = await supabase.from("plaid_tokens").delete().eq("id", tokenId).eq("user_id", userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Failed to delete token" });
  }
});

app.post("/api/transaction-status", async (req, res) => {
  try {
    const { access_token } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await plaidClient.transactionsGet({
      access_token,
      start_date: ninetyDaysAgo,
      end_date: today,
    });
    const transactions = response.data.transactions;
    if (transactions.length > 0) {
      return res.json({ status: "ready", transactions });
    }
    res.json({ status: "pending", transactions: [] });
  } catch (err) {
    const errData = err.response?.data;
    if (errData?.error_code === "PRODUCT_NOT_READY") {
      return res.json({ status: "pending", transactions: [] });
    }
    console.error(errData || err.message);
    res.status(500).json({ error: "Failed to check transaction status" });
  }
});

app.post("/api/balances", async (req, res) => {
  try {
    const { access_token } = req.body;
    const response = await plaidClient.accountsBalanceGet({ access_token });
    res.json({ accounts: response.data.accounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
});

app.post("/webhook", async (req, res) => {
  console.log("Webhook received:", req.body);
  res.json({ received: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
