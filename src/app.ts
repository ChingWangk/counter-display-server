import express from 'express';
import generateRouter from './routes/generate';
import categoriesRouter from './routes/categories';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/api/generate', generateRouter);
app.use('/api/categories', categoriesRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});