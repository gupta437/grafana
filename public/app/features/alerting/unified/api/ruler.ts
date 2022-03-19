import { lastValueFrom } from 'rxjs';
import { FetchResponse, getBackendSrv } from '@grafana/runtime';

import { PostableRulerRuleGroupDTO, RulerRuleGroupDTO, RulerRulesConfigDTO } from 'app/types/unified-alerting-dto';
import { getDatasourceAPIId, GRAFANA_RULES_SOURCE_NAME } from '../utils/datasource';
import { RULER_NOT_SUPPORTED_MSG } from '../utils/constants';
import { RulerDataSourceConfig } from 'app/types/unified-alerting';

interface ErrorResponseMessage {
  message?: string;
  error?: string;
}

function rulerUrlBuilder(rulerConfig: RulerDataSourceConfig) {
  const grafanaPath = `/api/ruler/${getDatasourceAPIId(rulerConfig.dataSourceName)}`;
  const rulerPath = rulerConfig.apiVersion === 'config' ? '/config/v1/rules' : '/api/v1/rules';

  const basePath = `${grafanaPath}${rulerPath}`;
  const rulerSearchParams = new URLSearchParams();
  if (rulerConfig.customRulerEnabled) {
    rulerSearchParams.set('source', 'ruler');
  }
  if (rulerConfig.apiVersion === 'legacy') {
    rulerSearchParams.set('noProxy', 'true');
  }

  return {
    rules: (filter?: FetchRulerRulesFilter) => {
      if (filter?.dashboardUID) {
        rulerSearchParams.set('dashboard_uid', filter.dashboardUID);
        if (filter.panelId) {
          rulerSearchParams.set('panel_id', String(filter.panelId));
        }
      }

      return {
        url: `${basePath}`,
        params: Object.fromEntries(rulerSearchParams),
      };
    },
    namespace: (namespace: string) => `${basePath}/${encodeURIComponent(namespace)}?${rulerSearchParams.toString()}`,
    namespaceGroup: (namespace: string, group: string) =>
      `${basePath}/${encodeURIComponent(namespace)}/${encodeURIComponent(group)}?${rulerSearchParams.toString()}`,
  };
}

// upsert a rule group. use this to update rule
export async function setRulerRuleGroup(
  rulerConfig: RulerDataSourceConfig,
  namespace: string,
  group: PostableRulerRuleGroupDTO
): Promise<void> {
  await lastValueFrom(
    getBackendSrv().fetch<unknown>({
      method: 'POST',
      url: rulerUrlBuilder(rulerConfig).namespace(namespace),
      data: group,
      showErrorAlert: false,
      showSuccessAlert: false,
    })
  );
}

export interface FetchRulerRulesFilter {
  dashboardUID: string;
  panelId?: number;
}

// fetch all ruler rule namespaces and included groups
export async function fetchRulerRules(rulerConfig: RulerDataSourceConfig, filter?: FetchRulerRulesFilter) {
  if (filter?.dashboardUID && rulerConfig.dataSourceName !== GRAFANA_RULES_SOURCE_NAME) {
    throw new Error('Filtering by dashboard UID is not supported for cloud rules sources.');
  }

  // TODO Move params creation to the rules function
  const { url, params } = rulerUrlBuilder(rulerConfig).rules(filter);
  return rulerGetRequest<RulerRulesConfigDTO>(url, {}, params);
}

// fetch rule groups for a particular namespace
// will throw with { status: 404 } if namespace does not exist
export async function fetchRulerRulesNamespace(rulerConfig: RulerDataSourceConfig, namespace: string) {
  const result = await rulerGetRequest<Record<string, RulerRuleGroupDTO[]>>(
    rulerUrlBuilder(rulerConfig).namespace(namespace),
    {}
  );
  return result[namespace] || [];
}

// fetch a particular rule group
// will throw with { status: 404 } if rule group does not exist
export async function fetchRulerRulesGroup(
  dataSourceName: string,
  namespace: string,
  group: string
): Promise<RulerRuleGroupDTO | null> {
  return rulerGetRequest<RulerRuleGroupDTO | null>(
    `/api/ruler/${getDatasourceAPIId(dataSourceName)}/api/v1/rules/${encodeURIComponent(
      namespace
    )}/${encodeURIComponent(group)}`,
    null
  );
}

export async function fetchRulerRulesGroupV2(
  rulerConfig: RulerDataSourceConfig,
  namespace: string,
  group: string
): Promise<RulerRuleGroupDTO | null> {
  return rulerGetRequest<RulerRuleGroupDTO | null>(rulerUrlBuilder(rulerConfig).namespaceGroup(namespace, group), null);
}

export async function deleteRulerRulesGroup(rulerConfig: RulerDataSourceConfig, namespace: string, groupName: string) {
  await lastValueFrom(
    getBackendSrv().fetch({
      url: rulerUrlBuilder(rulerConfig).namespaceGroup(namespace, groupName),
      method: 'DELETE',
      showSuccessAlert: false,
      showErrorAlert: false,
    })
  );
}

// false in case ruler is not supported. this is weird, but we'll work on it
async function rulerGetRequest<T>(url: string, empty: T, params?: Record<string, string>): Promise<T> {
  try {
    const response = await lastValueFrom(
      getBackendSrv().fetch<T>({
        url,
        showErrorAlert: false,
        showSuccessAlert: false,
        params,
      })
    );
    return response.data;
  } catch (error) {
    if (!isResponseError(error)) {
      throw error;
    }

    if (isCortexErrorResponse(error)) {
      return empty;
    } else if (isRulerNotSupported(error)) {
      // assert if the endoint is not supported at all
      throw {
        ...error,
        data: {
          ...error.data,
          message: RULER_NOT_SUPPORTED_MSG,
        },
      };
    }
    throw error;
  }
}

function isResponseError(error: unknown): error is FetchResponse<ErrorResponseMessage> {
  const hasErrorMessage = (error as FetchResponse<ErrorResponseMessage>).data != null;
  const hasErrorCode = Number.isFinite((error as FetchResponse<ErrorResponseMessage>).status);
  return hasErrorCode && hasErrorMessage;
}

function isRulerNotSupported(error: FetchResponse<ErrorResponseMessage>) {
  return (
    error.status === 404 ||
    (error.status === 500 &&
      error.data.message?.includes('unexpected content type from upstream. expected YAML, got text/html'))
  );
}

function isCortexErrorResponse(error: FetchResponse<ErrorResponseMessage>) {
  return (
    error.status === 404 &&
    (error.data.message?.includes('group does not exist') || error.data.message?.includes('no rule groups found'))
  );
}

export async function deleteNamespace(rulerConfig: RulerDataSourceConfig, namespace: string): Promise<void> {
  await lastValueFrom(
    getBackendSrv().fetch<unknown>({
      method: 'DELETE',
      url: rulerUrlBuilder(rulerConfig).namespace(namespace),
      showErrorAlert: false,
      showSuccessAlert: false,
    })
  );
}
