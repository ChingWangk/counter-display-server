import express from 'express';
import generateRouter from './routes/generate';
import categoriesRouter from './routes/categories';
import backCabinetSpecsRouter from './routes/backCabinetSpecs';
import customerSpecsRouter from './routes/customerSpecs';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/api/generate', generateRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/back-cabinet-specs', backCabinetSpecsRouter);
app.use('/api/customer-specs', customerSpecsRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});