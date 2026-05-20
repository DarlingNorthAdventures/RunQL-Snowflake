import { DPProviderDescriptor } from './types';

export const snowflakeProvider: DPProviderDescriptor = {
  providerId: 'snowflake',
  displayName: 'Snowflake',
  dialect: 'snowflake',
  formSchema: {
    fields: [
      {
        key: 'snowflakeImportInput',
        label: 'Auto-fill connection details',
        type: 'textarea',
        tab: 'connection',
        storage: 'local',
        placeholder: 'jdbc:snowflake://ABCDEFG.XY12345.snowflakecomputing.com/?user=...\nOR\n[connections.example]\naccount = "..."',
        description: 'Import Settings - Paste your JDBC/ODBC connection string or Snowflake TOML config snippet to auto-fill the connection details.',
        width: 'full'
      },
      {
        key: 'account',
        label: 'Account',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        required: true,
        placeholder: 'ABCDEFG.XY12345',
        description: 'Snowflake account identifier (e.g. ABCDEFG.XY12345). Do not include https:// or .snowflakecomputing.com',
        width: 'full'
      },
      {
        key: 'warehouse',
        label: 'Warehouse',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        required: true,
        width: 'half'
      },
      {
        key: 'role',
        label: 'Role (Optional)',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        width: 'half'
      },
      {
        key: 'database',
        label: 'Database',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        required: true,
        width: 'half'
      },
      {
        key: 'schema',
        label: 'Default Schema (Optional)',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        description: 'Sets the Snowflake session default schema. Introspection returns all visible schemas in the selected database.',
        width: 'half'
      },
      {
        key: 'authMode',
        label: 'Authentication Mode',
        type: 'select',
        tab: 'auth',
        storage: 'profile',
        defaultValue: 'keypair',
        options: [
          { value: 'keypair', label: 'Key-Pair Authentication (Default)' }
        ],
        width: 'full'
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        tab: 'auth',
        storage: 'profile',
        required: true,
        width: 'full'
      },
      {
        key: 'privateKeyPath',
        label: 'Private Key File (PEM)',
        type: 'file',
        tab: 'auth',
        storage: 'profile',
        required: true,
        placeholder: '/path/to/rsa_key.p8',
        visibleWhen: {
          storage: 'profile',
          key: 'authMode',
          equals: 'keypair'
        },
        picker: {
          mode: 'open',
          title: 'Select Private Key',
          openLabel: 'Select Private Key',
          canSelectFiles: true,
          canSelectFolders: false,
          filters: {
            'Key Files': ['p8', 'pem', 'key'],
            'All Files': ['*']
          }
        },
        description: 'Select your unencrypted or encrypted private key file.',
        width: 'full'
      },
      {
        key: 'privateKeyPassphrase',
        label: 'Passphrase (Optional)',
        type: 'password',
        tab: 'auth',
        storage: 'secrets',
        placeholder: 'If private key is encrypted',
        visibleWhen: {
          storage: 'profile',
          key: 'authMode',
          equals: 'keypair'
        },
        width: 'full'
      },
    ],
    actions: [
      {
        id: 'openInstructions',
        label: 'Instructions for Snowflake Connections',
        tab: 'connection',
        style: 'link'
      },
      {
        id: 'parseImport',
        label: 'Parse & Fill',
        tab: 'connection',
        style: 'secondary',
        payloadKeys: ['snowflakeImportInput']
      }
    ]
  },
  supports: {
    ssl: true,
    oauth: false,
    keypair: true,
    introspection: true,
    cancellation: true
  }
};
