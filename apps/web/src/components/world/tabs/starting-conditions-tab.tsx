import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
  text,
  inputCls,
  textareaCls,
  newResourceRow,
  resourceNameProblem,
  type ResourceRow,
  type StartingConditionsDraft,
  type TabProps,
} from "../editor-helpers.js";
import { fieldProblems, ProblemText } from "./field-problems.js";

export function StartingConditionsTab({
  dimensions,
  onChange,
  t,
  problems,
}: TabProps) {
  const sc: StartingConditionsDraft = dimensions.startingConditions ?? {
    openingScenario: "",
  };
  const problem = fieldProblems(problems);

  function setSc(next: StartingConditionsDraft) {
    onChange({ ...dimensions, startingConditions: next });
  }

  // Constraints
  function addConstraint() {
    setSc({
      ...sc,
      playerConstraints: [...(sc.playerConstraints ?? []), ""],
    });
  }

  function removeConstraint(index: number) {
    setSc({
      ...sc,
      playerConstraints: (sc.playerConstraints ?? []).filter(
        (_, i) => i !== index,
      ),
    });
  }

  function updateConstraint(index: number, value: string) {
    setSc({
      ...sc,
      playerConstraints: (sc.playerConstraints ?? []).map((c, i) =>
        i === index ? value : c,
      ),
    });
  }

  // Starting resources. Each row is found by its ID, never by its name: a
  // name that is being typed can be empty, or be for a moment the name of
  // another row, and neither may move a value or drop it.
  const resourceRows = sc.startingResources ?? [];

  function addResourceEntry() {
    setSc({ ...sc, startingResources: [...resourceRows, newResourceRow()] });
  }

  function removeResourceEntry(id: string) {
    setSc({
      ...sc,
      startingResources: resourceRows.filter((row) => row.id !== id),
    });
  }

  function updateResourceEntry(
    id: string,
    patch: Partial<Omit<ResourceRow, "id">>,
  ) {
    setSc({
      ...sc,
      startingResources: resourceRows.map((row) =>
        row.id === id ? { ...row, ...patch } : row,
      ),
    });
  }

  return (
    <div className="space-y-6">
      {/* Opening Scenario */}
      <div className="space-y-1">
        <Label htmlFor="world-starting-opening-scenario">
          {t("world.openingScenario")}
        </Label>
        <textarea
          id="world-starting-opening-scenario"
          className={textareaCls}
          value={text(sc.openingScenario)}
          onChange={(e) => setSc({ ...sc, openingScenario: e.target.value })}
        />
        {problem.at("openingScenario")}
      </div>

      {/* Starting Location */}
      <div className="space-y-1">
        <Label htmlFor="world-starting-location">
          {t("world.startingLocation")}
        </Label>
        <input
          id="world-starting-location"
          className={inputCls}
          value={text(sc.startingLocation)}
          onChange={(e) => setSc({ ...sc, startingLocation: e.target.value })}
        />
        {problem.at("startingLocation")}
      </div>

      {/* Player Constraints */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.playerConstraints")}</Label>
          <Button variant="outline" size="sm" onClick={addConstraint}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addConstraint")}
          </Button>
        </div>
        {problem.at("playerConstraints")}
        {(sc.playerConstraints ?? []).map((c, ci) => (
          <div key={ci} className="flex items-center gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <input
                aria-label={`${t("world.playerConstraints")} ${ci + 1}`}
                className={inputCls}
                value={text(c)}
                onChange={(e) => updateConstraint(ci, e.target.value)}
              />
              {problem.at(`playerConstraints.${ci}`)}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("world.remove")}
              onClick={() => removeConstraint(ci)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Starting Resources (key-value) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("world.startingResources")}</Label>
          <Button variant="outline" size="sm" onClick={addResourceEntry}>
            <Plus className="mr-1 h-4 w-4" />
            {t("world.addResource_kv")}
          </Button>
        </div>
        {problem.at("startingResources")}
        {resourceRows.map((row, ri) => {
          // A repeated name shows at once. The save adds the empty names.
          const repeated = resourceNameProblem(resourceRows, ri, t);
          return (
            <div key={row.id} className="flex items-start gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <input
                  aria-label={`${t("world.key")} ${ri + 1}`}
                  className={inputCls}
                  placeholder={t("world.key")}
                  value={row.name}
                  onChange={(e) =>
                    updateResourceEntry(row.id, { name: e.target.value })
                  }
                />
                <input
                  aria-label={`${t("world.value")} ${ri + 1}`}
                  className="w-full border border-border bg-background px-3 py-2 text-sm"
                  type="number"
                  placeholder={t("world.value")}
                  value={row.value}
                  onChange={(e) =>
                    updateResourceEntry(row.id, {
                      value: Number(e.target.value) || 0,
                    })
                  }
                />
                {problem.at(`startingResources.${ri}`) ??
                  (repeated && <ProblemText>{repeated}</ProblemText>)}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("world.remove")}
                onClick={() => removeResourceEntry(row.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>
      {problem.rest()}
    </div>
  );
}
