import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import SequelizeStoreModule from 'connect-session-sequelize';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Modules fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize express app first
const app = express();

// Trust proxy in production (Vercel, etc.)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Configure CORS with whitelisted origins - MUST BE BEFORE OTHER MIDDLEWARE
const allowedOrigins = [
  /^https?:\/\/localhost(:\d+)?$/,  // Allow any localhost with any port
  /\.vercel\.app$/,                  // Allow any Vercel preview domain
  'https://homeswift.ai',             // Production domain
  'https://www.homeswift.ai'          // Production domain with www
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if the origin matches any of the allowed patterns
    const isAllowed = allowedOrigins.some(pattern => 
      (pattern instanceof RegExp ? pattern.test(origin) : pattern === origin)
    );
    
    if (isAllowed) {
      return callback(null, true);
    }
    
    const msg = `CORS policy: ${origin} not allowed`;
    console.warn(msg);
    return callback(new Error(msg), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Access-Token',
    'X-Refresh-Token',
    'X-XSRF-TOKEN'
  ],
  exposedHeaders: [
    'Content-Range',
    'X-Total-Count',
    'X-Access-Token',
    'X-Refresh-Token',
    'Set-Cookie'
  ],
  maxAge: 86400, // 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Apply CORS middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Enable preflight for all routes

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// Import middleware and routes after CORS is configured
import models from './models/index.js';
import { checkRememberToken, loadUser } from './middleware/auth.js';
import jwtAuth from './middleware/jwtAuth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import searchRoutes from './routes/search.js';
import testRoutes from './routes/test.js';
import { propertyRouter } from './routes/propertyRoutes.js';

const PORT = process.env.PORT || 5000;

// Initialize models and database connection
console.log('Initializing database connection...');
try {
  await models.initialize();
  console.log('✅ Database connection established');
} catch (error) {
  console.error('❌ Database connection failed:', error);
  process.exit(1);
}

// Create session store with Sequelize

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Root route
app.get('/', (req, res) => {
  res.send('HomeSwift API is running 🚀');
});

// Favicon route
app.get('/favicon.ico', (req, res) => res.status(204).end());

// CORS is already configured at the top of the file

// Cookie parser middleware
app.use(cookieParser());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Determine if we're in production
const isProduction = process.env.NODE_ENV === 'production';

// Simple in-memory session configuration
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'dev-secret-key',
  resave: false,
  saveUninitialized: false,
  proxy: isProduction,
  cookie: {
    secure: isProduction ? true : 'auto',
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 2, // 2 hours
    domain: isProduction ? '.homeswift-ai.vercel.app' : 'localhost'
  },
  store: new session.MemoryStore({
    checkPeriod: 15 * 60 * 1000 // Check for expired sessions every 15 minutes
  })
};

console.log(isProduction ? '🚀 Production mode: Using in-memory session store' : '💻 Development mode: Using in-memory session store');

// Initialize session
const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);

// Logging middleware
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Test session endpoint
app.get('/api/session-test', (req, res) => {
  // Initialize view count if it doesn't exist
  if (!req.session.views) {
    req.session.views = 0;
  }
  
  // Increment view count
  req.session.views++;
  
  res.status(200).json({
    message: 'Session test successful',
    views: req.session.views,
    sessionId: req.sessionID,
    session: req.session
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: models.getSequelize() ? 'connected' : 'disconnected'
  });
});

// Apply authentication middleware
app.use(jwtAuth);
app.use(checkRememberToken);
app.use(loadUser);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/test', testRoutes);
app.use('/api/properties', propertyRouter);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.stack);
  
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await models.getSequelize().close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await models.getSequelize().close();
  process.exit(0);
});

// Error handling middleware (must be last)
app.use((err, req, res, next) => {
  console.error('Server Error:', err.stack || err);
  res.status(err.status || 500).json({ 
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for multiple origins`);
  console.log(`🗄️  Database: ${models.getSequelize() ? 'Connected' : 'Disconnected'}`);
});

export default app;
