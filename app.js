import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import AuthRoutes from './routes/auth.route.js';
import errorHandler from './middlewares/errorHandler.js';

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

app.use('/api/auth', AuthRoutes);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'hello world' });
});

app.use(errorHandler);

export default app;
