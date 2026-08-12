import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// ESLint 9 usa la flat config. Next 16 ha rimosso `next lint`: si lancia
// direttamente `eslint .` (script `npm run lint`).
const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
];

export default config;
