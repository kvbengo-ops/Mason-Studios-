export const TEAMS = ["hybrid_editor", "ai_animator"] as const;
export type Team = (typeof TEAMS)[number];

export const TEAM_LABELS: Readonly<Record<Team, string>> = {
  hybrid_editor: "Hybrid Editor",
  ai_animator: "AI Animator",
};

export function isTeam(value: unknown): value is Team {
  return (TEAMS as readonly unknown[]).includes(value);
}

/**
 * Which video models a team may use. A team limits models only; spend and
 * permissions stay with the role. No team (null) is unrestricted, so nobody
 * loses access on deploy.
 */
export function canUseVideoModel(team: Team | null | undefined, modelId: string): boolean {
  return team === "hybrid_editor" ? modelId !== "wan-3.0" : true;
}
