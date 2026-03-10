import express from 'express';
import generateRouter from './routes/generate';

const app = express();
const PORT = 3000;

app.use(express.json());

app.use('/api/generate', generateRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
