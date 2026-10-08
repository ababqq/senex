/**
 * Settings → Permissions shows what is always allowed by action, not by project: one row per saved
 * rule, with every project that holds it, so thirty projects that allow `npm install` are one row.
 */
import type { PermissionRuleView } from "../shared/permissions.ts";

/** One action allowed without asking, and the projects that allow it. */
export interface AllowedAction {
  rule: string;
  projects: Array<{ project: string; title: string }>;
}

/** Each saved rule once, with its projects in the order the host lists them; the most shared first. */
export function allowedActions(views: readonly PermissionRuleView[]): AllowedAction[] {
  const byRule = new Map<string, AllowedAction>();
  for (const view of views)
    for (const rule of view.rules) {
      const action = byRule.get(rule) ?? { rule, projects: [] };
      action.projects.push({ project: view.project, title: view.title || view.project });
      byRule.set(rule, action);
    }
  // A stable sort keeps the host's order among actions held by as many projects.
  return [...byRule.values()].sort((a, b) => b.projects.length - a.projects.length);
}
