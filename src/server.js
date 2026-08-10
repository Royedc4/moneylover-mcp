import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MoneyloverClient, MoneyloverApiError } from './moneyloverClient.js';
import { readToken, writeToken, removeToken } from './tokenCache.js';

const DIRECT_TOKEN_ENV_KEYS = ['MONEYLOVER_TOKEN', 'MONEY_LOVER_TOKEN'];
const ENV_FILE_DISABLE_FLAG = 'MONEYLOVER_MCP_DISABLE_ENV_FILE';
const ENV_FILE_PATH_ENV = 'MONEYLOVER_MCP_ENV_FILE';

let envFileLoaded = false;

const normalizeEnvValue = value => {
  if (!value) {
    return '';
  }
  let trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\\\', '\\');
};

const applyEnvFile = raw => {
  if (!raw) {
    return;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!key || typeof process.env[key] !== 'undefined') {
      continue;
    }
    const value = normalizeEnvValue(line.slice(separatorIndex + 1));
    process.env[key] = value;
  }
};

const loadEnvFileIfNeeded = () => {
  if (envFileLoaded) {
    return;
  }
  envFileLoaded = true;
  if (process.env[ENV_FILE_DISABLE_FLAG] === '1') {
    return;
  }

  const candidates = [];
  const customPath = process.env[ENV_FILE_PATH_ENV]?.trim();
  if (customPath) {
    candidates.push(customPath);
  }
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(moduleDir, '..', '.env'));
  } catch (error) {
    console.warn('Failed to resolve module directory for env loading:', error);
  }
  candidates.push(path.resolve(process.cwd(), '.env'));

  const visited = new Set();
  for (const candidate of candidates) {
    const normalized = candidate ? path.resolve(candidate) : '';
    if (!normalized || visited.has(normalized)) {
      continue;
    }
    visited.add(normalized);
    try {
      const raw = fs.readFileSync(normalized, 'utf8');
      applyEnvFile(raw);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('Failed to load environment file', normalized, error);
      }
    }
  }
};

const getEnvConfig = () => {
  loadEnvFileIfNeeded();
  const email = process.env.EMAIL?.trim() ?? '';
  const password = process.env.PASSWORD?.trim() ?? '';
  const directToken = DIRECT_TOKEN_ENV_KEYS.map(key => process.env[key]?.trim()).find(Boolean) ?? '';
  return { email, password, directToken };
};

let cachedEnvEmail = '';
let cachedEnvToken = '';
let envTokenPromise = null;
let cacheLoaded = false;
let cachedEnvUsesDirectToken = false;

const formatSuccess = data => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(data, null, 2)
    }
  ],
  structuredContent: data
});

const formatError = error => {
  const base = {
    error: error.name,
    message: error.message
  };
  if (typeof error.code !== 'undefined' && error.code !== null) {
    base.code = error.code;
  }
  if (error.detail) {
    base.detail = error.detail;
  }

  return {
    content: [
      {
        type: 'text',
        text: error.message
      }
    ],
    structuredContent: base,
    isError: true
  };
};

const withClient = async (token, fn) => {
  const client = new MoneyloverClient(token);
  return fn(client);
};

const hasEnvCredentials = () => {
  const { email, password, directToken } = getEnvConfig();
  return Boolean(directToken || (email && password));
};

const fetchEnvToken = async (forceRefresh = false) => {
  const { email, password, directToken } = getEnvConfig();

  if (directToken) {
    cachedEnvUsesDirectToken = true;
    cachedEnvEmail = email;
    cachedEnvToken = directToken;
    envTokenPromise = null;
    cacheLoaded = true;
    return directToken;
  }

  if (cachedEnvUsesDirectToken) {
    cachedEnvUsesDirectToken = false;
    cachedEnvToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
  }

  if (!email || !password) {
    return null;
  }

  if (email !== cachedEnvEmail) {
    cachedEnvEmail = email;
    cachedEnvToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
  }

  if (forceRefresh) {
    cachedEnvToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
    try {
      await removeToken(email);
    } catch (error) {
      console.warn('Failed to clear cached Money Lover token:', error);
    }
  }
  if (!cacheLoaded) {
    try {
      const storedToken = await readToken(email);
      if (storedToken) {
        cachedEnvToken = storedToken;
      }
    } catch (error) {
      console.warn('Failed to read cached Money Lover token:', error);
    }
    cacheLoaded = true;
  }
  if (cachedEnvToken) {
    return cachedEnvToken;
  }
  if (!envTokenPromise) {
    envTokenPromise = MoneyloverClient.getToken(email, password)
      .then(async token => {
        try {
          await writeToken(email, token);
        } catch (error) {
          console.warn('Failed to persist Money Lover token:', error);
        }
        cachedEnvToken = token;
        cacheLoaded = true;
        envTokenPromise = null;
        return token;
      })
      .catch(error => {
        envTokenPromise = null;
        throw error;
      });
  }
  return envTokenPromise;
};

const missingTokenError = () =>
  new Error(
    'Token is required. Provide a token parameter or set EMAIL/PASSWORD, MONEYLOVER_TOKEN, or a .env file for automatic authentication.'
  );

const isAuthError = error => {
  if (!(error instanceof MoneyloverApiError)) {
    return false;
  }
  if (typeof error.code === 'number' && (error.code === 1 || error.code === 401)) {
    return true;
  }
  const message = error.message?.toLowerCase?.() ?? '';
  return message.includes('unauth') || message.includes('token');
};

const runWithResolvedToken = async (providedToken, fn) => {
  let usedEnvToken = false;
  let token = providedToken;
  if (!token) {
    token = await fetchEnvToken();
    if (!token) {
      throw missingTokenError();
    }
    usedEnvToken = true;
  }

  try {
    return await fn(token);
  } catch (error) {
    if (usedEnvToken && isAuthError(error)) {
      const refreshedToken = await fetchEnvToken(true);
      if (!refreshedToken) {
        throw error;
      }
      return fn(refreshedToken);
    }
    throw error;
  }
};

const runWithClient = (token, fn) => runWithResolvedToken(token, resolvedToken => withClient(resolvedToken, fn));

const registerMoneyloverTools = server => {
  const tokenSchema = z.preprocess(value => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    }
    return value;
  }, z.string().min(1).optional());

  server.registerTool(
    'login',
    {
      title: 'Login to Money Lover',
      description: 'Authenticate using Money Lover credentials to retrieve a JWT token.',
      inputSchema: {
        email: z.string().email().describe('Money Lover account email'),
        password: z.string().min(1).describe('Money Lover account password')
      },
      outputSchema: {
        token: z.string()
      }
    },
    async ({ email, password }) => {
      try {
        const token = await MoneyloverClient.getToken(email, password);
        try {
          await writeToken(email, token);
        } catch (error) {
          console.warn('Failed to persist Money Lover token:', error);
        }
        const { email: envEmail } = getEnvConfig();
        if (email === envEmail && envEmail) {
          cachedEnvEmail = envEmail;
          cachedEnvToken = token;
          cacheLoaded = true;
          cachedEnvUsesDirectToken = false;
        }
        return formatSuccess({ token });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  const tokenArgument = {
    token: tokenSchema.describe(
      'JWT token returned by the login tool or derived from EMAIL/PASSWORD environment variables'
    )
  };

  server.registerTool(
    'get_user_info',
    {
      title: 'Get User Info',
      description: 'Retrieve the Money Lover user profile associated with the provided token.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = await runWithClient(token, client => client.getUserInfo());
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_wallets',
    {
      title: 'Get Wallets',
      description: 'List all wallets accessible to the authenticated user.',
      inputSchema: tokenArgument,
      outputSchema: {
        wallets: z.array(z.record(z.any()))
      }
    },
    async ({ token }) => {
      try {
        const wallets = (await runWithClient(token, client => client.getWallets())) ?? [];
        return formatSuccess({ wallets });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_categories',
    {
      title: 'Get Categories',
      description:
        'Retrieve categories for a specific wallet. Returns the global category IDs that are accepted by add_transaction. IDs are discovered from transaction history and cached for 5 minutes.',
      inputSchema: {
        ...tokenArgument,
        walletId: z.string().min(1).describe('Wallet identifier')
      },
      outputSchema: {
        categories: z.array(z.record(z.any()))
      }
    },
    async ({ token, walletId }) => {
      try {
        const categories = await runWithClient(token, client => client.getCategoryGlobalIds(walletId));
        return formatSuccess({ categories });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_transactions',
    {
      title: 'Get Transactions',
      description: 'Fetch transactions for a wallet between two dates.',
      inputSchema: {
        ...tokenArgument,
        walletId: z.string().min(1).describe('Wallet identifier'),
        startDate: z
          .string()
          .regex(/\d{4}-\d{2}-\d{2}/)
          .describe('Start date in YYYY-MM-DD format'),
        endDate: z
          .string()
          .regex(/\d{4}-\d{2}-\d{2}/)
          .describe('End date in YYYY-MM-DD format')
      }
    },
    async ({ token, walletId, startDate, endDate }) => {
      try {
        const data = await runWithClient(token, client => client.getTransactions(walletId, startDate, endDate));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'add_transaction',
    {
      title: 'Add Transaction',
      description: 'Create a new transaction in a wallet.',
      inputSchema: {
        ...tokenArgument,
        walletId: z.string().min(1).describe('Wallet identifier'),
        categoryId: z.string().min(1).describe('Category identifier — must be a global ID from get_categories, not a wallet-local ID'),
        amount: z.string().min(1).describe('Transaction amount as string'),
        note: z.string().optional().describe('Optional transaction note'),
        date: z
          .string()
          .regex(/\d{4}-\d{2}-\d{2}/)
          .describe('Display date in YYYY-MM-DD format'),
        with: z
          .array(z.string())
          .optional()
          .describe('Optional array of related parties'),
        campaignId: z
          .string()
          .min(1)
          .optional()
          .describe('Optional campaign/event identifier to associate with the transaction')
      }
    },
    async ({ token, ...payload }) => {
      try {
        const data = await runWithClient(token, client =>
          client.addTransaction({
            walletId: payload.walletId,
            categoryId: payload.categoryId,
            amount: payload.amount,
            note: payload.note,
            date: payload.date,
            with: payload.with,
            campaignId: payload.campaignId
          })
        );
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'edit_transaction',
    {
      title: 'Edit Transaction',
      description:
        'Update an existing transaction. Only the fields you pass change; the rest are read from the current record. Editing one leg of a transfer does NOT update its twin — use get_related_transactions first.',
      inputSchema: {
        ...tokenArgument,
        transactionId: z.string().min(1).describe('Transaction _id to update'),
        walletId: z.string().min(1).describe('Wallet identifier the transaction belongs to'),
        categoryId: z
          .string()
          .min(1)
          .optional()
          .describe('New category — must be a global ID from get_categories'),
        amount: z.number().optional().describe('New amount (numeric, unlike add_transaction)'),
        note: z.string().optional().describe('New note'),
        date: z
          .string()
          .regex(/\d{4}-\d{2}-\d{2}/)
          .optional()
          .describe('New display date in YYYY-MM-DD format'),
        excludeReport: z.boolean().optional().describe('Exclude this transaction from reports'),
        with: z.array(z.string()).optional().describe('Related parties'),
        campaignId: z.string().optional().describe('Campaign/event identifier ("" clears it)')
      }
    },
    async ({ token, ...payload }) => {
      try {
        const data = await runWithClient(token, client => client.editTransaction(payload));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete Transaction',
      description:
        'Permanently delete a transaction. Irreversible — requires confirm: true. For a transfer, set deleteRelated: true or the opposite leg is left stranded and the two wallets desync.',
      inputSchema: {
        ...tokenArgument,
        transactionId: z.string().min(1).describe('Transaction _id to delete'),
        deleteRelated: z
          .boolean()
          .optional()
          .describe('Also delete the linked transfer leg in the other wallet (default false)'),
        confirm: z
          .boolean()
          .describe('Must be true. Guards against accidental deletion — there is no undo.')
      }
    },
    async ({ token, transactionId, deleteRelated, confirm }) => {
      try {
        if (confirm !== true) {
          throw new Error('Refusing to delete: pass confirm: true to acknowledge this cannot be undone');
        }
        const data = await runWithClient(token, client =>
          client.deleteTransaction(transactionId, { deleteRelated })
        );
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_related_transactions',
    {
      title: 'Get Related Transactions',
      description:
        'Fetch the opposite leg(s) of transfers. A transfer is two linked records — an outgoing one in the source wallet and an incoming one in the destination. Call this before editing or deleting a transfer.',
      inputSchema: {
        ...tokenArgument,
        transactionIds: z
          .array(z.string().min(1))
          .min(1)
          .describe('One or more transaction _ids to look up twins for')
      }
    },
    async ({ token, transactionIds }) => {
      try {
        const data = await runWithClient(token, client => client.getRelatedTransactions(transactionIds));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );
};

export const createMoneyloverServer = () => {
  const server = new McpServer({
    name: 'moneylover-mcp-server',
    version: '0.0.3'
  });
  registerMoneyloverTools(server);
  return server;
};

export const startMoneyloverServer = async () => {
  const server = createMoneyloverServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
};

export const __test = {
  hasEnvCredentials,
  fetchEnvToken,
  runWithResolvedToken,
  runWithClient,
  clearEnvTokenCache: () => {
    cachedEnvEmail = '';
    cachedEnvToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
    cachedEnvUsesDirectToken = false;
    envFileLoaded = false;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  startMoneyloverServer().catch(error => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Money Lover MCP server failed to start:', err.message);
    if (err instanceof MoneyloverApiError && err.detail) {
      console.error('Detail:', JSON.stringify(err.detail));
    }
    process.exitCode = 1;
  });
}
