import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import chatsRouter from './routes/chats.js';
import qqRouter from './routes/qq.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('FireFly0619');
})

app.use('/chats', chatsRouter);
app.use('/qq', qqRouter);

app.listen('619', () => {
    console.log('listening on port 619');
    console.log('QQ webhook: http://127.0.0.1:619/qq/webhook');
})