import type { DiscoveryContext, DiscoveryEvidence, DiscoveryProvider, EvidenceKind } from "../../contracts/index.js";
import { loadAllDependencies, type Ecosystem } from "../manifests.js";
import { evidenceFactory, normalizeVersion } from "../util.js";

type Category = "web" | "ui" | "test" | "orm" | "api" | "cli" | "runtime" | "build" | "lint" | "validation" | "styling" | "mobile" | "desktop";

interface CatalogEntry {
  name: string;
  category: Category;
}

const fw = (name: string, category: Category): CatalogEntry => ({ name, category });

const NPM: Record<string, CatalogEntry> = {
  react: fw("React", "ui"),
  "react-dom": fw("React DOM", "ui"),
  next: fw("Next.js", "web"),
  vue: fw("Vue", "ui"),
  nuxt: fw("Nuxt", "web"),
  svelte: fw("Svelte", "ui"),
  "@sveltejs/kit": fw("SvelteKit", "web"),
  "@angular/core": fw("Angular", "ui"),
  "solid-js": fw("SolidJS", "ui"),
  astro: fw("Astro", "web"),
  "@remix-run/react": fw("Remix", "web"),
  express: fw("Express", "web"),
  fastify: fw("Fastify", "web"),
  koa: fw("Koa", "web"),
  hono: fw("Hono", "web"),
  "@nestjs/core": fw("NestJS", "web"),
  "@hapi/hapi": fw("hapi", "web"),
  electron: fw("Electron", "desktop"),
  "react-native": fw("React Native", "mobile"),
  expo: fw("Expo", "mobile"),
  graphql: fw("GraphQL", "api"),
  "@apollo/server": fw("Apollo Server", "api"),
  "@trpc/server": fw("tRPC", "api"),
  prisma: fw("Prisma", "orm"),
  "@prisma/client": fw("Prisma", "orm"),
  "drizzle-orm": fw("Drizzle ORM", "orm"),
  typeorm: fw("TypeORM", "orm"),
  sequelize: fw("Sequelize", "orm"),
  mongoose: fw("Mongoose", "orm"),
  zod: fw("Zod", "validation"),
  vitest: fw("Vitest", "test"),
  jest: fw("Jest", "test"),
  mocha: fw("Mocha", "test"),
  ava: fw("AVA", "test"),
  "@playwright/test": fw("Playwright", "test"),
  cypress: fw("Cypress", "test"),
  "@testing-library/react": fw("Testing Library (React)", "test"),
  tailwindcss: fw("Tailwind CSS", "styling"),
  // Tooling (reported as kind "tooling").
  typescript: fw("TypeScript compiler", "build"),
  vite: fw("Vite", "build"),
  webpack: fw("webpack", "build"),
  rollup: fw("Rollup", "build"),
  esbuild: fw("esbuild", "build"),
  tsup: fw("tsup", "build"),
  turbo: fw("Turborepo", "build"),
  nx: fw("Nx", "build"),
  eslint: fw("ESLint", "lint"),
  prettier: fw("Prettier", "lint"),
  "@biomejs/biome": fw("Biome", "lint"),
};

const PYPI: Record<string, CatalogEntry> = {
  fastapi: fw("FastAPI", "web"),
  django: fw("Django", "web"),
  flask: fw("Flask", "web"),
  starlette: fw("Starlette", "web"),
  aiohttp: fw("aiohttp", "web"),
  tornado: fw("Tornado", "web"),
  pydantic: fw("Pydantic", "validation"),
  sqlalchemy: fw("SQLAlchemy", "orm"),
  alembic: fw("Alembic", "orm"),
  "django-rest-framework": fw("Django REST framework", "api"),
  djangorestframework: fw("Django REST framework", "api"),
  celery: fw("Celery", "runtime"),
  pytest: fw("pytest", "test"),
  hypothesis: fw("Hypothesis", "test"),
  typer: fw("Typer", "cli"),
  click: fw("Click", "cli"),
  uvicorn: fw("Uvicorn", "runtime"),
  gunicorn: fw("Gunicorn", "runtime"),
  ruff: fw("Ruff", "lint"),
  black: fw("Black", "lint"),
  mypy: fw("mypy", "lint"),
};

const GO: Array<[string, CatalogEntry]> = [
  ["github.com/gin-gonic/gin", fw("Gin", "web")],
  ["github.com/labstack/echo", fw("Echo", "web")],
  ["github.com/gofiber/fiber", fw("Fiber", "web")],
  ["github.com/go-chi/chi", fw("chi", "web")],
  ["github.com/gorilla/mux", fw("Gorilla mux", "web")],
  ["google.golang.org/grpc", fw("gRPC", "api")],
  ["github.com/spf13/cobra", fw("Cobra", "cli")],
  ["github.com/urfave/cli", fw("urfave/cli", "cli")],
  ["github.com/stretchr/testify", fw("Testify", "test")],
  ["gorm.io/gorm", fw("GORM", "orm")],
  ["github.com/jackc/pgx", fw("pgx", "orm")],
];

const CARGO: Record<string, CatalogEntry> = {
  "actix-web": fw("Actix Web", "web"),
  axum: fw("Axum", "web"),
  rocket: fw("Rocket", "web"),
  warp: fw("warp", "web"),
  tokio: fw("Tokio", "runtime"),
  serde: fw("Serde", "validation"),
  clap: fw("clap", "cli"),
  diesel: fw("Diesel", "orm"),
  sqlx: fw("SQLx", "orm"),
  tonic: fw("tonic", "api"),
};

/** Maven group/artifact prefixes ("group:artifact" or "group:"). Gradle plugins are "plugin:<id>". */
const MAVEN: Array<[string, CatalogEntry]> = [
  ["org.springframework.boot:spring-boot-starter-parent", fw("Spring Boot", "web")],
  ["plugin:org.springframework.boot", fw("Spring Boot", "web")],
  ["org.springframework.boot:spring-boot-starter-web", fw("Spring Web MVC", "web")],
  ["org.springframework.boot:spring-boot-starter-webflux", fw("Spring WebFlux", "web")],
  ["org.springframework.boot:spring-boot-starter-data-jpa", fw("Spring Data JPA", "orm")],
  ["org.springframework.boot:spring-boot-starter-test", fw("Spring Boot Test", "test")],
  ["org.springframework.boot:", fw("Spring Boot", "web")],
  ["org.springframework:spring-", fw("Spring Framework", "web")],
  ["io.quarkus:", fw("Quarkus", "web")],
  ["io.micronaut:", fw("Micronaut", "web")],
  ["org.junit.jupiter:", fw("JUnit 5", "test")],
  ["junit:junit", fw("JUnit 4", "test")],
  ["org.testng:testng", fw("TestNG", "test")],
  ["org.mockito:", fw("Mockito", "test")],
  ["org.hibernate", fw("Hibernate", "orm")],
  ["org.projectlombok:lombok", fw("Lombok", "build")],
];

const TOOLING: ReadonlySet<Category> = new Set(["build", "lint"]);

function lookup(ecosystem: Ecosystem, dep: string): CatalogEntry | undefined {
  switch (ecosystem) {
    case "npm":
      return NPM[dep];
    case "pypi":
      return PYPI[dep.toLowerCase().replace(/_/g, "-")];
    case "cargo":
      return CARGO[dep];
    case "go":
      return GO.find(([prefix]) => dep === prefix || dep.startsWith(`${prefix}/`))?.[1];
    case "maven":
      return MAVEN.find(([prefix]) => dep === prefix || (prefix.endsWith(":") || prefix.endsWith("-") || !prefix.includes(":") ? dep.startsWith(prefix) : false))?.[1];
  }
}

/** P0: frameworks, test frameworks and tooling with versions, from parsed manifests. */
export class FrameworkProvider implements DiscoveryProvider {
  readonly id = "framework";
  readonly priority = "P0" as const;

  supports(): boolean {
    return true;
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveryEvidence[]> {
    const ev = evidenceFactory(this.id, this.priority);
    const out: DiscoveryEvidence[] = [];
    for (const manifest of await loadAllDependencies(ctx)) {
      const seen = new Set<string>();
      for (const dep of manifest.dependencies) {
        const entry = lookup(manifest.ecosystem, dep.name);
        if (!entry || seen.has(entry.name)) continue;
        seen.add(entry.name);
        const kind: EvidenceKind = TOOLING.has(entry.category) ? "tooling" : "framework";
        const version = normalizeVersion(dep.spec);
        const where = dep.scope === "prod" ? "" : ` ${dep.scope}`;
        out.push(
          ev(kind, manifest.path, `Uses ${entry.name}${dep.spec ? ` ${dep.spec}` : ""} (${dep.name}${where} dependency in ${manifest.path})`, {
            value: {
              name: entry.name,
              package: dep.name,
              ecosystem: manifest.ecosystem,
              category: entry.category,
              scope: dep.scope,
              ...(dep.spec ? { spec: dep.spec } : {}),
              ...(version ? { version } : {}),
            },
          }),
        );
      }
    }
    return out;
  }
}
