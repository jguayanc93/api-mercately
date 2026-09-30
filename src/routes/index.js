import { Router } from 'express';

import productos from './productos.js';
import sync from './sync.js';

const router = Router();

router.use('/productos', productos);
router.use('/sync', sync);

export default router;
