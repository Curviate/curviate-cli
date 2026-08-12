/**
 * Captured `specifics.experience` entries from a real profile response.
 *
 * NOT hand-authored. This is the live capture that serves as the shared oracle
 * for the profile-sections shape across the whole stack: the server's fake
 * adapter serves it, a server contract test asserts the published schema
 * declares every key in it, and the CLI's projector tests assert against it
 * here. A fixture invented to match what a projector already assumed is how
 * the previous bug survived: the projector read `position` / `company`-as-a-
 * string / `end`, its tests pinned those same invented names, and the pair
 * stayed green while disagreeing with every real response.
 *
 * Field semantics, established by live measurement, not inferred:
 *
 *   - `job_title` is the role name. There is no `position` key.
 *   - `company` is an OBJECT (`{id, name, picture_url, profile_url}`), never a
 *     name string. So `company.id` is a genuine company id.
 *   - `started_on` / `ended_on` are the date keys. There is no `start`/`end`.
 *   - `ended_on` PRESENT means the role ended; ABSENT means it is current.
 *     Absence is the only signal; there is no boolean anywhere on the entry.
 *   - Dates are `MM/DD/YYYY` with month-and-year precision only.
 *   - An `ended_on` is the first of the end month plus 29 days, which stays
 *     inside a 30/31-day month but rolls a February end into the following
 *     March: `03/02/2025` below means FEBRUARY 2025, cross-checked against the
 *     profile's own displayed tenure. Reading the month straight off
 *     `ended_on` overstates a February tenure by a month. The value is NOT
 *     corrected upstream, deliberately, so that the API agrees with the
 *     platform; anything deriving a month from it owes the -29d correction.
 *
 * Dates keep the platform's own encoding and must not be normalised here: the
 * point of the fixture is that a test sees exactly what a consumer sees.
 *
 * Deliberately carries all three cases: a current role with no end key, a
 * February-ending role, and an ordinary ended role.
 */
export const CAPTURED_EXPERIENCE: Record<string, unknown>[] = [
  // Current role: carries started_on and NO end key of any kind.
  {
    id: "2774251286",
    company: {
      id: "112013061",
      name: "Example Ventures",
      picture_url: "https://media.example.com/example-ventures.png",
      profile_url: "https://www.linkedin.com/company/112013061/",
    },
    job_title: "Founder",
    started_on: "01/01/2026",
    location: "Remote",
    employment_type: "SELF_EMPLOYED",
  },
  // Ended role, February end: the value falls in the following March.
  {
    id: "2774251287",
    company: {
      id: "112013062",
      name: "Example Systems",
      picture_url: "https://media.example.com/example-systems.png",
      profile_url: "https://www.linkedin.com/company/112013062/",
    },
    job_title: "Senior Machine Learning Engineer",
    started_on: "08/01/2024",
    ended_on: "03/02/2025",
    location: "Bonn, North Rhine-Westphalia, Germany",
    description: "Built and shipped production inference services.",
    workplace_type: "HYBRID",
    skills_preview: "Python, Kubernetes",
  },
  // Ended role, non-February end: the value stays inside the end month.
  {
    id: "2774251288",
    company: {
      id: "112013063",
      name: "Example Media",
      picture_url: "https://media.example.com/example-media.png",
      profile_url: "https://www.linkedin.com/company/112013063/",
    },
    job_title: "Data Science Developer",
    started_on: "08/01/2023",
    ended_on: "07/30/2024",
    location: "Bonn",
    employment_type: "PERMANENT",
  },
];

/** Captured `specifics.education` entries. `school` is an object, not a name string. */
export const CAPTURED_EDUCATION: Record<string, unknown>[] = [
  {
    id: "948681979",
    school: {
      id: "22336379",
      name: "Example University",
      picture_url: "https://media.example.com/example-university.png",
      profile_url: "https://www.linkedin.com/company/22336379/",
    },
    degree: "Master of Science",
    fields_of_study: ["Economics"],
  },
];
