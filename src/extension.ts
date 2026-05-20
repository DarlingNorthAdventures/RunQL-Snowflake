import * as vscode from 'vscode';
import { RunQLExtensionApi, DPProviderActionResult } from './types';
import { snowflakeProvider } from './provider';
import { SnowflakeAdapter } from './snowflakeAdapter';
import { ensureSnowflakeInstructions, openSnowflakeInstructions } from './snowflakeInstructions';
import { parseSnowflakeImport } from './snowflakeImportParser';

const AUTO_OPEN_KEY = 'runql.snowflake.setupGuideAutoOpened.v1';

async function autoOpenSetupGuideOnFirstInstall(context: vscode.ExtensionContext): Promise<void> {
  const alreadyOpened = context.globalState.get<boolean>(AUTO_OPEN_KEY, false);
  if (alreadyOpened) {
    return;
  }

  const uri = await ensureSnowflakeInstructions();
  if (!uri) {
    return;
  }

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    await context.globalState.update(AUTO_OPEN_KEY, true);
  } catch {
    // User can open manually from command.
  }
}

function handleProviderAction(actionId: string, payload: Record<string, unknown>): DPProviderActionResult {
  if (actionId === 'openInstructions') {
    void openSnowflakeInstructions();
    return {};
  }

  if (actionId === 'parseImport') {
    const input = String(payload.snowflakeImportInput ?? '').trim();
    if (!input) {
      return {
        status: {
          type: 'error',
          text: 'Please paste a connection string to parse.'
        }
      };
    }

    const result = parseSnowflakeImport(input);
    const fields = result.fields ?? {};
    const hasFields = Object.keys(fields).length > 0;

    let status: DPProviderActionResult['status'];
    if (result.ignoredKeys.length > 0) {
      status = {
        type: 'info',
        text: `Imported fields. Ignored unsupported keys: ${result.ignoredKeys.join(', ')}`
      };
    } else if (hasFields) {
      status = {
        type: 'success',
        text: 'Connection settings imported successfully.'
      };
    } else {
      status = {
        type: 'error',
        text: 'Could not parse any connection fields from input.'
      };
    }

    return {
      profilePatch: {
        ...(fields.account ? { account: fields.account } : {}),
        ...(fields.username ? { username: fields.username } : {}),
        ...(fields.warehouse ? { warehouse: fields.warehouse } : {}),
        ...(fields.database ? { database: fields.database } : {}),
        ...(fields.schema ? { schema: fields.schema } : {}),
        ...(fields.role ? { role: fields.role } : {})
      },
      localPatch: {
        snowflakeImportInput: ''
      },
      status
    };
  }

  return {
    status: {
      type: 'error',
      text: `Unknown Snowflake action: ${actionId}`
    }
  };
}

export async function activate(context: vscode.ExtensionContext) {
  const core = vscode.extensions.getExtension<RunQLExtensionApi>('RunQL-VSCode-Extension.runql');
  if (!core) {
    vscode.window.showWarningMessage('RunQL Snowflake Connector requires RunQL-VSCode-Extension.runql.');
    return;
  }

  const api = await core.activate();
  if (!api || typeof api.registerProvider !== 'function' || typeof api.registerAdapter !== 'function' || typeof api.registerProviderActionHandler !== 'function') {
    vscode.window.showWarningMessage('RunQL core API is unavailable. Update RunQL and try again.');
    return;
  }

  context.subscriptions.push(
    api.registerProvider(snowflakeProvider),
    api.registerAdapter('snowflake', () => new SnowflakeAdapter()),
    api.registerProviderActionHandler('snowflake', handleProviderAction),
    vscode.commands.registerCommand('runql.snowflake.openSetupGuide', async () => {
      await openSnowflakeInstructions();
    })
  );

  void ensureSnowflakeInstructions();
  void autoOpenSetupGuideOnFirstInstall(context);
}

export function deactivate() {
  // no-op
}
