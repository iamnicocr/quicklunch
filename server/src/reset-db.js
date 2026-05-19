import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');
for (const name of ['quicklunch_users.db','quicklunch_users.db-shm','quicklunch_users.db-wal','quicklunch_restaurants.db','quicklunch_restaurants.db-shm','quicklunch_restaurants.db-wal','quicklunch_core.db','quicklunch_core.db-shm','quicklunch_core.db-wal']) {
  const file = path.join(dataDir, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
console.log('Bases QuickLunch reiniciadas. Ejecuta npm run dev para reconstruirlas con el usuario owner inicial.');
