import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import AuthRoutes from './routes/auth.route.js';
import GoogleRoutes from './routes/googleAuth.route.js';
import errorHandler from './middlewares/errorHandler.js';
import session from 'express-session';
import passport from 'passport';
import './utils/googleAuth.js';

const app = express();
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
    methods: ['POST', 'GET', 'DELETE', 'PUT'],
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: 'mysecret',
    resave: false,
    saveUninitialized: true,
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
  const now = new Date();
  const formattedDate = now.toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  console.debug(`[${formattedDate}] ${req.method} ${req.originalUrl} from ${req.ip}`);
  next();
});

app.get('/', (req, res) => {
  res.json({ success: true, message: 'hello world' });
});
app.use('/api/auth', AuthRoutes);
app.use('/api/googleAuth', GoogleRoutes);

app.use(errorHandler);

export default app;
