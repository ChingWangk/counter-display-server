import express from 'express';
import generateRouter from './routes/generate';
import categoriesRouter from './routes/categories';
import backCabinetSpecsRouter from './routes/backCabinetSpecs';
import customerSpecsRouter from './routes/customerSpecs';
import customerInfoRouter from './routes/customerInfo';
import customerCountersRouter from './routes/customerCounters';
import customerInventoryRouter from './routes/customerInventory';
import yangpuAvgPriceRouter from './routes/yangpuAvgPrice';
import yangpuStockoutRouter from './routes/yangpuStockout';
import praiseScriptRouter from './routes/praiseScript';
import substituteRecommendRouter from './routes/substituteRecommend';
import activeSeasonsRouter from './routes/activeSeasons';
import marketCoverageRouter from './routes/marketCoverage';
import orderFillRateRouter from './routes/orderFillRate';
import wholesaleRankRouter from './routes/wholesaleRank';
import localBrandGrowthRouter from './routes/localBrandGrowth';
import zonesAvailableRouter from './routes/zonesAvailable';
import festivalSpecsRouter from './routes/festivalSpecs';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/api/generate', generateRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/back-cabinet-specs', backCabinetSpecsRouter);
app.use('/api/customer-specs', customerSpecsRouter);
app.use('/api/customer-info', customerInfoRouter);
app.use('/api/customer-counters', customerCountersRouter);
app.use('/api/customer-inventory', customerInventoryRouter);
app.use('/api/yangpu-avg-price', yangpuAvgPriceRouter);
app.use('/api/yangpu-stockout', yangpuStockoutRouter);
app.use('/api/praise-script', praiseScriptRouter);
app.use('/api/substitute-recommend', substituteRecommendRouter);
app.use('/api/active-seasons', activeSeasonsRouter);
app.use('/api/market-coverage', marketCoverageRouter);
app.use('/api/order-fill-rate', orderFillRateRouter);
app.use('/api/wholesale-rank', wholesaleRankRouter);
app.use('/api/local-brand-growth', localBrandGrowthRouter);
app.use('/api/zones/available', zonesAvailableRouter);
app.use('/api/festival-specs', festivalSpecsRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
