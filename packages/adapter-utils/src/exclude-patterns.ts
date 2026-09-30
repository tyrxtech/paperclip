export function isRelativePathOrDescendant(relative: string, candidate: string): boolean {
  return relative === candidate || relative.startsWith(`${candidate}/`);
}

function pathContainsSegmentOrDescendant(relative: string, segment: string): boolean {
  return relative === segment ||
    relative.startsWith(`${segment}/`) ||
    relative.endsWith(`/${segment}`) ||
    relative.includes(`/${segment}/`);
}

export function excludePatternMatches(relative: string, pattern: string): boolean {
  if (pattern.startsWith("*/") && pattern.endsWith("/*")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2, -2));
  }
  if (pattern.startsWith("*/")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2));
  }
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return relative.startsWith(`${base}/`);
  }
  return isRelativePathOrDescendant(relative, pattern);
}

export function shouldExcludePath(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => excludePatternMatches(relative, entry));
}

/**
 * Dependency trees are host-specific build output (native binaries for the
 * machine that installed them) and are usually the bulk of a workspace, so
 * SSH workspace sync never transfers them in either direction and the restore
 * merge never deletes them. The execution host installs its own copy. Both
 * forms are needed: a bare name matches top-level only here, `*\/name` matches
 * the segment at any depth; tar treats either form as unanchored.
 */
export const WORKSPACE_SYNC_HOST_LOCAL_EXCLUDES = ["node_modules", "*/node_modules"] as const;
