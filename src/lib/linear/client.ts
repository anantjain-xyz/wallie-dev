import "server-only";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export type LinearIssue = {
  description: string;
  id: string;
  identifier: string;
  title: string;
  url: string;
};

type LinearIssueResponse = {
  data?: {
    issue?: {
      description: string | null;
      id: string;
      identifier: string;
      title: string;
      url: string;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

const issueQuery = /* GraphQL */ `
  query Issue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
    }
  }
`;

export async function fetchLinearIssue(
  apiKey: string,
  issueIdentifier: string,
): Promise<LinearIssue> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    body: JSON.stringify({
      query: issueQuery,
      variables: { id: issueIdentifier },
    }),
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Linear API request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as LinearIssueResponse;

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`Linear API error: ${payload.errors.map((e) => e.message).join("; ")}`);
  }

  const issue = payload.data?.issue;

  if (!issue) {
    throw new Error(`Linear issue not found: ${issueIdentifier}`);
  }

  return {
    description: issue.description ?? "",
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  };
}

export async function verifyLinearApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      body: JSON.stringify({
        query: /* GraphQL */ `
          query Viewer {
            viewer {
              id
              name
            }
          }
        `,
      }),
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      return { error: `Linear API returned ${response.status}.`, ok: false };
    }

    const payload = (await response.json()) as {
      data?: { viewer?: { id: string } | null };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      return { error: payload.errors.map((e) => e.message).join("; "), ok: false };
    }

    if (!payload.data?.viewer?.id) {
      return { error: "Linear API key did not return a viewer.", ok: false };
    }

    return { ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Linear API verification failed.",
      ok: false,
    };
  }
}
