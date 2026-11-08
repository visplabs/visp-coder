// SonarQube Cloud's issues on a pull request's new code, for the coder that has to fix them and
// for the retro. The project is public, so reading needs no token. SDLC_SONAR_URL replaces the
// host in tests.

export async function pullRequestIssues(sonar, pr) {
  const base = process.env.SDLC_SONAR_URL ?? sonar.url;
  const params = new URLSearchParams({
    componentKeys: sonar.projectKey,
    pullRequest: String(pr),
    resolved: "false",
    ps: "100",
  });
  const response = await fetch(`${base}/api/issues/search?${params}`);
  if (!response.ok) throw new Error(`SonarQube Cloud answered ${response.status}`);
  const { issues = [] } = await response.json();
  return issues.map((issue) => ({
    rule: issue.rule,
    path: issue.component.slice(issue.component.indexOf(":") + 1),
    line: issue.line,
    message: issue.message,
  }));
}
