import { defineConfig } from 'vitest/config';
import path from 'node:path';

const lib = (p: string) => path.resolve(import.meta.dirname, 'lib-origin', p);

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@origin\/(.*)$/, replacement: `${lib('origin/src')}/$1` },
			{ find: /^@common\/(.*)$/, replacement: `${lib('common')}/$1` },
			{ find: /^@illusive\/(.*)$/, replacement: `${lib('Illusive/src')}/$1` },
			{ find: /^@native\/(.*)$/, replacement: `${lib('roze/native')}/$1` },
			{ find: /^@lib\/(.*)$/, replacement: `${lib('roze/lib')}/$1` },
			{ find: /^@sample\/(.*)$/, replacement: `${lib('sample')}/$1` },
			{ find: /^react-native-quick-crypto$/, replacement: path.resolve(import.meta.dirname, 'src/shims/quick_crypto.ts') }
		]
	},
	test: {
		include: ['src/**/*.test.ts'],
		env: {
			DATABASE_URL: 'postgres://test:test@localhost:5432/test',
			JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0000',
			ACTION_TOKEN_SECRET: 'test-action-secret-test-action-secret-0000'
		}
	}
});
