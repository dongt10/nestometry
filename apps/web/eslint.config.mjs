import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    settings: {
      react: {
        version: '19.2.8',
      },
    },
  },
  {
    files: ['src/components/DormSelector.tsx'],
    rules: {
      // These effects synchronize browser capability/mode transitions with
      // local controls; deriving the values during SSR would cause hydration
      // mismatches and moving the resets into render would be incorrect.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['src/components/RoomViewer3D.tsx'],
    rules: {
      // React Three Fiber exposes mutable Three.js scene, camera, renderer,
      // and material objects specifically for effects and frame callbacks.
      'react-hooks/immutability': 'off',
      // Leaving walk mode synchronously resets transient pointer-lock UI.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);
