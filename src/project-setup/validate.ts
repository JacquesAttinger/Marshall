// Last edited: 2026-10-11 21:00 PDT
// Strict input checks for the "add a project" form. Everything the pipeline passes to `gh` or
// `git`, or joins into a path, goes through here first: names are a small safe alphabet, an
// existing repo is `owner/name` or one github.com URL, and nothing may point outside ~/code.

import { isAbsolute, join, relative } from "node:path";
import { ProjectError, slugify } from "../projects.ts";
import type { CreateProjectInput, RepoChoice } from "./types.ts";

/** A mistake in what the person typed. The message is safe to show. */
export class InputError extends Error {
  override name = "InputError";
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const OWNER_NAME = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/;
/** Linear keys are one printable token: no spaces, quotes, or newlines. */
const API_KEY = /^[A-Za-z0-9_.-]{10,200}$/;

/** A repo with the owner known (existing) or to be looked up (new). */
export interface RepoRef {
  mode: "new" | "existing";
  owner?: string;
  name: string;
}

export interface ValidInput {
  name: string;
  slug: string;
  linearApiKey: string;
  repo: RepoRef;
  teamId?: string;
}

export function checkApiKey(key: unknown): string {
  if (typeof key !== "string" || !API_KEY.test(key.trim())) {
    throw new InputError("That does not look like a Linear API key.");
  }
  return key.trim();
}

/** A repo name that is safe as an argument and as one path segment. */
export function checkRepoName(name: string): string {
  if (
    !REPO_NAME.test(name) ||
    name.startsWith("-") ||
    name.startsWith(".") ||
    name.includes("..") ||
    name.endsWith(".git")
  ) {
    throw new InputError(
      "A repo name uses letters, numbers, dots, dashes and underscores only, and cannot start with a dot or dash.",
    );
  }
  return name;
}

function checkOwner(owner: string): string {
  if (!OWNER.test(owner)) throw new InputError("That GitHub owner name is not valid.");
  return owner;
}

function parseExisting(text: string): RepoRef {
  const match = GITHUB_URL.exec(text) ?? OWNER_NAME.exec(text);
  if (!match) {
    throw new InputError("Use owner/name or an https://github.com/owner/name address.");
  }
  return {
    mode: "existing",
    owner: checkOwner(match[1] as string),
    name: checkRepoName(match[2] as string),
  };
}

export function validateRepo(repo: RepoChoice | undefined, projectSlug: string): RepoRef {
  if (!repo || (repo.mode !== "new" && repo.mode !== "existing")) {
    throw new InputError("Choose a new repo or an existing one.");
  }
  if (repo.mode === "new") {
    const name = typeof repo.name === "string" && repo.name.trim() ? repo.name.trim() : projectSlug;
    return { mode: "new", name: checkRepoName(name) };
  }
  const text = [repo.url, repo.name].find((v) => typeof v === "string" && v.trim());
  if (typeof text !== "string") throw new InputError("Enter the existing repo.");
  return parseExisting(text.trim());
}

/** Reject any body field of the wrong type before it reaches the pipeline. */
export function validateInput(raw: unknown): ValidInput {
  if (!raw || typeof raw !== "object") throw new InputError("The request body must be an object.");
  const body = raw as Partial<CreateProjectInput>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 60 || /\p{Cc}/u.test(name)) {
    throw new InputError("Give the project a name of 1 to 60 characters.");
  }
  let slug: string;
  try {
    slug = slugify(name);
  } catch (err) {
    if (err instanceof ProjectError)
      throw new InputError("Use some letters or numbers in the name.");
    throw err;
  }
  const teamId = body.teamId;
  if (teamId !== undefined && (typeof teamId !== "string" || teamId.length > 100)) {
    throw new InputError("The team is not valid.");
  }
  return {
    name,
    slug,
    linearApiKey: checkApiKey(body.linearApiKey),
    repo: validateRepo(body.repo, slug),
    teamId: teamId || undefined,
  };
}

/** `<codeDir>/<name>`, refusing any result outside `codeDir`. */
export function repoPathFor(codeDir: string, name: string): string {
  const path = join(codeDir, checkRepoName(name));
  const rel = relative(codeDir, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new InputError("The repo would land outside the code folder.");
  }
  return path;
}
