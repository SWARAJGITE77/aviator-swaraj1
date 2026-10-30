const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const crypto = require('crypto'); 
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Temporary Email Blocker import kiya
const { isTempMail } = require('tempmail-blocker');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ================= MONGODB CONNECTION =================
// YAHAN APNA NAYA LINK PASTE KARO
const MONGO_URI = "mongodb+srv://swarajgite63_db_user:Swaraj12345@aviator-swaraj.mxfhw6b.mongodb.net/"; 

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully!"))
  .catch(err => console.log("❌ MongoDB Connection Error: ", err));

// ================= SECRET KEYS =================
const JWT_SECRET = "MeraSuperSecretKey123"; 
const ADMIN_USERNAME = "swarajgite63@gmail.com";
const ADMIN_PASSWORD = "SrG1010@"; 
let validAdminTokens = [];

// ================= DATABASE MODELS =================
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true }, // Email
  mobile: { type: String, unique: true, required: true }, // Mobile
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  todayWithdrawn: { type: Number, default: 0 },
  lastWithdrawDate: { type: String, default: new Date().toDateString() },
  totalDeposited: { type: Number, default: 0 },
  totalWagered: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

const depositSchema = new mongoose.Schema({
  userId: String, amount: Number, utr: String, upiUsed: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
// Niche wali line waise hi rahegi: const Deposit = mongoose.model('Deposit', depositSchema);
const Deposit = mongoose.model('Deposit', depositSchema);

const withdrawSchema = new mongoose.Schema({
  userId: String, amount: Number, mode: String, upiId: String, bankDetails: Object,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const Withdraw = mongoose.model('Withdraw', withdrawSchema);

// Game Variables
let forcedCrash = null; 
let phase = 'waiting';
let multiplier = 1.0;
let crashAt = 0;
let countdown = 5; 

// ================= AUTH APIS (REGISTER/LOGIN) =================

app.post('/api/auth/register', async (req, res) => {
  const { email, mobile, password } = req.body; 
  if (!email || !mobile || !password) return res.status(400).json({ error: "Email, Mobile and Password are required" });

  // 1. Temporary Email Check
  if (isTempMail(email)) {
    return res.status(400).json({ error: "Temporary email addresses are not allowed. Please use a real email." });
  }

  // 2. India Mobile Number Validation
  const indianMobileRegex = /^[6-9]\d{9}$/;
  if (!indianMobileRegex.test(mobile)) {
    return res.status(400).json({ error: "Please enter a valid 10-digit Indian mobile number." });
  }

  // 3. Check Email Exists
  let existingEmail = await User.findOne({ userId: email });
  if (existingEmail) return res.status(400).json({ error: "Email already registered" });

  // 4. Check Mobile Exists
  let existingMobile = await User.findOne({ mobile: mobile });
  if (existingMobile) return res.status(400).json({ error: "Mobile number already registered" });

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const newUser = await User.create({ userId: email, mobile: mobile, password: hashedPassword });
  const token = jwt.sign({ userId: newUser.userId }, JWT_SECRET, { expiresIn: '7d' });
  
  res.json({ success: true, token, userId: newUser.userId, balance: newUser.balance });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ userId: email });
  if (!user) return res.status(400).json({ error: "Invalid Email or Password" });

  const validPass = await bcrypt.compare(password, user.password);
  if (!validPass) return res.status(400).json({ error: "Invalid Email or Password" });

  const token = jwt.sign({ userId: user.userId }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, userId: user.userId, balance: user.balance });
});

// ================= SECURITY (ADMIN) =================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    validAdminTokens.push(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: "Invalid Credentials" });
  }
});

const verifyAdmin = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token || !validAdminTokens.includes(token)) {
    return res.status(403).json({ error: "Unauthorized Access!" });
  }
  next();
};

// ================= USER APIS =================

const getOrCreateUser = async (userId) => {
  let user = await User.findOne({ userId });
  if (!user) {
    // Agar naya user hai aur mobile nahi hai, toh temporary mobile daal do
    const tempMobile = "9" + Math.floor(100000000 + Math.random() * 900000000); 
    user = await User.create({ userId, password: "social_login_placeholder", mobile: tempMobile });
  }
  return user;
};

app.post('/api/user/deposit', async (req, res) => {
  const { userId, amount, utr, upiUsed } = req.body; 
  if (!amount || amount < 100 || amount > 50000) return res.status(400).json({ error: "Deposit amount must be between ₹100 and ₹50,000" });
  if (!utr || utr.length < 12) return res.status(400).json({ error: "Invalid UTR" });
  
  await getOrCreateUser(userId);
  await Deposit.create({ userId, amount: parseFloat(amount), utr, upiUsed });
  
  io.emit('new-deposit'); 
  res.json({ success: true, msg: "Deposit submitted successfully." });
});

app.post('/api/user/track-bet', async (req, res) => {
  const { userId, amount } = req.body;
  const user = await getOrCreateUser(userId);
  
  if (user.balance < amount) return res.status(400).json({ error: "Insufficient balance" });

  user.balance -= parseFloat(amount);
  user.totalWagered += parseFloat(amount);
  await user.save();
  
  const requiredWager = user.totalDeposited * 0.80;
  const remainingWager = Math.max(0, requiredWager - user.totalWagered);
  
  io.emit('balanceUpdated', { userId, newBalance: user.balance });
  io.emit('wagerUpdated', { userId, remainingWager });
  
  res.json({ success: true });
});

app.post('/api/user/cashout', async (req, res) => {
  const { userId, winAmount } = req.body;
  const user = await getOrCreateUser(userId);

  user.balance += parseFloat(winAmount);
  await user.save();
  
  io.emit('balanceUpdated', { userId, newBalance: user.balance });
  res.json({ success: true });
});

app.post('/api/user/withdraw', async (req, res) => {
  const { userId, amount, withdrawMode, upiId, bankDetails } = req.body;
  const minLimit = withdrawMode === 'UPI' ? 200 : 100;
  if (!amount || amount < minLimit) return res.status(400).json({ error: `Minimum withdrawal for ${withdrawMode} is ₹${minLimit}` });
  
  const user = await getOrCreateUser(userId);

  const requiredWager = user.totalDeposited * 0.80;
  if (user.totalWagered < requiredWager) {
    const remaining = (requiredWager - user.totalWagered).toFixed(2);
    return res.status(400).json({ error: `Wagering requirement pending. You need to bet ₹${remaining} more.` });
  }

  const today = new Date().toDateString();
  if (user.lastWithdrawDate !== today) {
    user.todayWithdrawn = 0;
    user.lastWithdrawDate = today;
  }

  if (user.todayWithdrawn + amount > 30000) return res.status(400).json({ error: "Daily withdrawal limit of ₹30,000 exceeded." });
  if (user.balance < amount) return res.status(400).json({ error: "Insufficient balance" });
  
  user.balance -= amount;
  user.todayWithdrawn += amount; 
  await user.save();

  await Withdraw.create({ userId, amount: parseFloat(amount), mode: withdrawMode, upiId: withdrawMode === 'UPI' ? upiId : null, bankDetails: withdrawMode === 'BANK' ? bankDetails : null });
  
  io.emit('new-withdraw'); 
  io.emit('balanceUpdated', { userId, newBalance: user.balance });
  res.json({ success: true });
});

app.get('/api/user/balance/:userId', async (req, res) => {
  const user = await getOrCreateUser(req.params.userId);
  const requiredWager = user.totalDeposited * 0.80;
  const remainingWager = Math.max(0, requiredWager - user.totalWagered);
  res.json({ balance: user.balance, totalDeposited: user.totalDeposited, totalWagered: user.totalWagered, remainingWager });
});

// ================= ADMIN APIS =================
app.post('/api/admin/set-crash', verifyAdmin, (req, res) => { forcedCrash = parseFloat(req.body.crashPoint); res.json({ success: true }); });
app.post('/api/admin/manual-crash', verifyAdmin, (req, res) => {
  if (phase === 'flying') { crashAt = multiplier; res.json({ success: true }); } 
  else if (phase === 'waiting') { countdown = 0.1; res.json({ success: true }); } 
  else { res.status(400).json({ error: "Game is not flying" }); }
});

app.get('/api/admin/deposits', verifyAdmin, async (req, res) => {
  const deposits = await Deposit.find({ status: 'pending' }).sort({ createdAt: -1 });
  res.json(deposits);
});

app.post('/api/admin/deposit-action', verifyAdmin, async (req, res) => {
  const { depositId, action } = req.body;
  
  try {
    let deposit = null;

    // 1. Pehle naye MongoDB ID format se dhoondho
    if (mongoose.Types.ObjectId.isValid(depositId)) {
      deposit = await Deposit.findById(depositId);
    }

    // 2. Agar nahi mila, toh purane Date.now() wale format se dhoondho
    if (!deposit) {
      deposit = await Deposit.findOne({ id: depositId });
    }

    if (!deposit) {
      return res.status(404).json({ error: "Deposit request not found in database." });
    }

    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: "This deposit is already " + deposit.status });
    }

    // Status update karo
    deposit.status = action === 'approve' ? 'approved' : 'rejected';
    await deposit.save();
    
    // Agar approve kiya hai, toh user ko paisa do
    if (action === 'approve') {
      const user = await getOrCreateUser(deposit.userId);
      user.balance += deposit.amount;
      user.totalDeposited += deposit.amount;
      await user.save();
      
      io.emit('balanceUpdated', { userId: deposit.userId, newBalance: user.balance });
    }
    
    res.json({ success: true, msg: "Deposit " + action + "d successfully!" });

  } catch (err) {
    console.log("Deposit Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
app.get('/api/admin/withdrawals', verifyAdmin, async (req, res) => {
  const withdrawals = await Withdraw.find({ status: 'pending' }).sort({ createdAt: -1 });
  res.json(withdrawals);
});

app.post('/api/admin/withdraw-action', verifyAdmin, async (req, res) => {
  const { withdrawId, action } = req.body;
  const w = await Withdraw.findById(withdrawId);
  if (w && w.status === 'pending') {
    w.status = action === 'approve' ? 'approved' : 'rejected';
    await w.save();
    
    if (action === 'reject') {
      const user = await getOrCreateUser(w.userId);
      user.balance += w.amount;
      user.todayWithdrawn -= w.amount;
      await user.save();
      io.emit('balanceUpdated', { userId: w.userId, newBalance: user.balance });
    }
    res.json({ success: true });
  } else {
    res.status(400).json({ error: "Invalid request" });
  }
});

// ================= GAME ENGINE =================
setInterval(() => {
  if (phase === 'waiting') {
    countdown = +(countdown - 0.1).toFixed(1); 
    if (countdown <= 0) {
      phase = 'flying'; multiplier = 1.0;
      crashAt = forcedCrash || +(1.2 + Math.random() * 5).toFixed(2);
      forcedCrash = null; 
      io.emit('gameState', { phase, multiplier, crashAt, countdown: 0 });
    } else {
      io.emit('gameState', { phase, multiplier, crashAt, countdown });
    }
  } 
  else if (phase === 'flying') {
    multiplier = +(multiplier + 0.01).toFixed(2);
    if (multiplier >= crashAt) {
      phase = 'crashed'; multiplier = crashAt;
      io.emit('gameState', { phase, multiplier, crashAt, countdown: 0 });
      setTimeout(() => {
        phase = 'waiting'; countdown = 5.0; 
        io.emit('roundReset'); 
        io.emit('gameState', { phase, multiplier: 1.0, crashAt: 0, countdown });
      }, 1000); 
    } else {
      io.emit('gameState', { phase, multiplier, crashAt, countdown: 0 });
    }
  }
}, 100);

server.listen(3001, () => console.log("Backend Server running on port 3001"));