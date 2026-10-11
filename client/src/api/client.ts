import type {
  AAR,
  CompleteResponse,
  EventCreateRequest,
  EventCreated,
  PerformanceProfile,
  RecommendRequest,
  RecommendResponse,
  Scenario,
  ScenarioGenerateRequest,
  SessionCreateRequest,
  SessionCreated,
} from './types';

export interface ApiClient {
  generateScenario(request: ScenarioGenerateRequest): Promise<Scenario>;
  createSession(request: SessionCreateRequest): Promise<SessionCreated>;
  submitEvent(sessionId: string, event: EventCreateRequest): Promise<EventCreated>;
  completeSession(sessionId: string): Promise<CompleteResponse>;
  fetchAar(sessionId: string): Promise<AAR>;
  fetchPerformance(traineeId: string): Promise<PerformanceProfile>;
  recommendTraining(request: RecommendRequest): Promise<RecommendResponse>;
}

export function createApiClient(
  base = '/api/v1',
  fetchFn: typeof fetch = fetch,
): ApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchFn(base + path, init);
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const parsed = (await response.json()) as { detail?: unknown };
        if (parsed.detail !== undefined) detail = String(parsed.detail);
      } catch {
        // keep statusText
      }
      throw new Error(response.status + ' ' + detail);
    }
    return (await response.json()) as T;
  }

  const jsonHeaders = { 'Content-Type': 'application/json' };

  function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: jsonHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function get<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'GET' });
  }

  return {
    generateScenario: (request) => post<Scenario>('/scenarios/generate', request),
    createSession: (request) => post<SessionCreated>('/sessions', request),
    submitEvent: (sessionId, event) =>
      post<EventCreated>('/sessions/' + encodeURIComponent(sessionId) + '/events', event),
    completeSession: (sessionId) =>
      post<CompleteResponse>('/sessions/' + encodeURIComponent(sessionId) + '/complete'),
    fetchAar: (sessionId) => get<AAR>('/sessions/' + encodeURIComponent(sessionId) + '/aar'),
    fetchPerformance: (traineeId) =>
      get<PerformanceProfile>('/trainees/' + encodeURIComponent(traineeId) + '/performance'),
    recommendTraining: (request) => post<RecommendResponse>('/training/recommend', request),
  };
}