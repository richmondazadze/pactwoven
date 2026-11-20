BEGIN;

-- Isolated, unnumbered C3 candidate. Reapply only the exact reviewed bytes.
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_epochs(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,epoch bigint NOT NULL CHECK(epoch BETWEEN 1 AND 4),
 previous_epoch bigint NOT NULL,original_plan jsonb NOT NULL,usage jsonb NOT NULL,request_key text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id,epoch),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id),CHECK(epoch=previous_epoch+1));
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_lineages(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,epoch bigint NOT NULL,logical_task_id text NOT NULL,revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 32),
 task_id text NOT NULL,handoff_id text NOT NULL,kind text NOT NULL CHECK(kind IN('retained','replacement')),body jsonb NOT NULL,original_handoff jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(environment,organization_id,root_task_id,epoch,logical_task_id,revision),
 FOREIGN KEY(environment,organization_id,root_task_id,epoch) REFERENCES pactwoven.native_delegation_refresh_epochs(environment,organization_id,root_task_id,epoch));
CREATE INDEX IF NOT EXISTS native_refresh_lineage_task ON pactwoven.native_delegation_refresh_lineages(environment,organization_id,task_id);
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_manifests(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,epoch bigint NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),slots jsonb NOT NULL,
 PRIMARY KEY(environment,organization_id,root_task_id,epoch,digest),FOREIGN KEY(environment,organization_id,root_task_id,epoch) REFERENCES pactwoven.native_delegation_refresh_epochs(environment,organization_id,root_task_id,epoch));
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_current(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,epoch bigint NOT NULL,lineage_digest text NOT NULL,
 PRIMARY KEY(environment,organization_id,root_task_id),
 FOREIGN KEY(environment,organization_id,root_task_id,epoch,lineage_digest) REFERENCES pactwoven.native_delegation_refresh_manifests(environment,organization_id,root_task_id,epoch,digest));
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_generations(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,generation bigint NOT NULL,epoch bigint NOT NULL,lineage_digest text NOT NULL,
 PRIMARY KEY(environment,organization_id,root_task_id,generation),
 FOREIGN KEY(environment,organization_id,root_task_id,epoch,lineage_digest) REFERENCES pactwoven.native_delegation_refresh_manifests(environment,organization_id,root_task_id,epoch,digest));
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_commands(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,request_key text NOT NULL,kind text NOT NULL CHECK(kind IN('refresh','dispatch')),
 generation bigint NOT NULL,identity jsonb NOT NULL,intent jsonb NOT NULL,intent_digest text NOT NULL,response jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,root_task_id,request_key),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id),
 CHECK(request_key~'^c3_[a-f0-9]{64}$'),CHECK(intent_digest=pactwoven.native_delegation_hash(intent)));
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_dispositions(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,task_id text NOT NULL,reason text NOT NULL CHECK(reason IN('cancelled','blocked')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(environment,organization_id,root_task_id,task_id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_runs(environment,organization_id,root_task_id));
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_observations(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,epoch bigint NOT NULL,task_id text NOT NULL,handoff_id text NOT NULL,
 publication_digest text NOT NULL,observations jsonb NOT NULL,provenance_digest text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(environment,organization_id,handoff_id),
 FOREIGN KEY(environment,organization_id,handoff_id) REFERENCES pactwoven.native_delegation_results(environment,organization_id,handoff_id),
 FOREIGN KEY(environment,organization_id,root_task_id,epoch) REFERENCES pactwoven.native_delegation_refresh_epochs(environment,organization_id,root_task_id,epoch),
 CHECK(provenance_digest=pactwoven.native_delegation_hash(observations)));
CREATE TABLE IF NOT EXISTS pactwoven.native_delegation_refresh_completions(
 environment text NOT NULL,organization_id text NOT NULL,root_task_id text NOT NULL,epoch bigint NOT NULL,lineage_digest text NOT NULL,generation bigint NOT NULL,publication_digest text NOT NULL,
 PRIMARY KEY(environment,organization_id,root_task_id),
 FOREIGN KEY(environment,organization_id,root_task_id) REFERENCES pactwoven.native_delegation_root_completions(environment,organization_id,root_task_id),
 FOREIGN KEY(environment,organization_id,root_task_id,epoch,lineage_digest) REFERENCES pactwoven.native_delegation_refresh_manifests(environment,organization_id,root_task_id,epoch,digest));

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_require(q jsonb,k text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE normalized jsonb:=q; items jsonb:='[]'; item jsonb;BEGIN IF k='publication' AND jsonb_typeof(q#>'{publication,artifacts}')='array' THEN FOR item IN SELECT value FROM jsonb_array_elements(q#>'{publication,artifacts}') LOOP IF jsonb_typeof(item->'body') IS DISTINCT FROM 'object' OR octet_length((item->'body')::text)>65536 THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Bounded artifact object required';END IF;items:=items||jsonb_build_array(item||jsonb_build_object('body','{}'::jsonb));END LOOP;normalized:=jsonb_set(q,'{publication,artifacts}',items);END IF;IF q IS NULL OR octet_length(q::text)>524288 OR NOT pactwoven.native_delegation_matches(normalized,$descriptors${
  "refresh": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 2
      },
      "requestKey": {
        "type": "string",
        "minLength": 16,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "expectedRefreshEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expectedCheckpointVersion": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "results": {
        "minItems": 1,
        "maxItems": 32,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "handoffId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "^[A-Za-z0-9_-]+$"
            },
            "publicationDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "handoffId",
            "publicationDigest"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "schemaVersion",
      "requestKey",
      "expectedRefreshEpoch",
      "expectedCheckpointVersion",
      "results"
    ],
    "additionalProperties": false
  },
  "dispatch": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 2
      },
      "requestKey": {
        "type": "string",
        "minLength": 16,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "expectedRefreshEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expectedCheckpointVersion": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "lineageDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "logicalTaskId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9_-]+$"
      }
    },
    "required": [
      "schemaVersion",
      "requestKey",
      "expectedRefreshEpoch",
      "expectedCheckpointVersion",
      "lineageDigest",
      "logicalTaskId"
    ],
    "additionalProperties": false
  },
  "operation": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "refresh",
          "dispatch"
        ]
      },
      "requestKey": {
        "type": "string",
        "minLength": 16,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "intentDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    "required": [
      "kind",
      "requestKey",
      "intentDigest"
    ],
    "additionalProperties": false
  },
  "coordinator_state": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 1
      },
      "inputDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "plan": {
        "type": "object",
        "properties": {
          "objective": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1200
          },
          "steps": {
            "maxItems": 6,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 180
                },
                "brief": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2400
                },
                "role": {
                  "type": "string",
                  "enum": [
                    "research",
                    "planning",
                    "escalation"
                  ]
                }
              },
              "required": [
                "title",
                "brief",
                "role"
              ],
              "additionalProperties": false
            }
          },
          "limitations": {
            "maxItems": 6,
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            }
          },
          "question": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1,
                "maxLength": 600
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "objective",
          "steps",
          "limitations",
          "question"
        ],
        "additionalProperties": false
      },
      "slots": {
        "maxItems": 6,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "taskId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "^[A-Za-z0-9_-]+$"
            },
            "handoffId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "^[A-Za-z0-9_-]+$"
            },
            "requestKey": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "^[A-Za-z0-9_-]+$"
            },
            "assignment": {
              "type": "object",
              "properties": {
                "schemaVersion": {
                  "type": "number",
                  "const": 1
                },
                "stepId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128,
                  "pattern": "^[A-Za-z0-9_-]+$"
                },
                "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 180
                },
                "brief": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2400
                },
                "role": {
                  "type": "string",
                  "enum": [
                    "research",
                    "planning",
                    "escalation"
                  ]
                },
                "memoryReferences": {
                  "maxItems": 32,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "environment": {
                        "type": "string",
                        "enum": [
                          "simulation",
                          "development",
                          "staging",
                          "production"
                        ]
                      },
                      "organizationId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "pattern": "^[A-Za-z0-9_-]+$"
                      },
                      "siteId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "pattern": "^[A-Za-z0-9_-]+$"
                      },
                      "memoryId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "pattern": "^[A-Za-z0-9_-]+$"
                      },
                      "revision": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 9007199254740991
                      },
                      "digest": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      }
                    },
                    "required": [
                      "environment",
                      "organizationId",
                      "siteId",
                      "memoryId",
                      "revision",
                      "digest"
                    ],
                    "additionalProperties": false
                  }
                }
              },
              "required": [
                "schemaVersion",
                "stepId",
                "title",
                "brief",
                "role",
                "memoryReferences"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "taskId",
            "handoffId",
            "requestKey",
            "assignment"
          ],
          "additionalProperties": false
        }
      },
      "usage": {
        "type": "object",
        "properties": {
          "inputTokens": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "outputTokens": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "totalTokens": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "inputTokens",
          "outputTokens",
          "totalTokens"
        ],
        "additionalProperties": false
      },
      "bounded": {
        "type": "boolean"
      },
      "attempt": {
        "type": "integer",
        "minimum": 1,
        "maximum": 4
      }
    },
    "required": [
      "schemaVersion",
      "inputDigest",
      "plan",
      "slots",
      "usage",
      "bounded",
      "attempt"
    ],
    "additionalProperties": false
  },
  "inputs": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 2
      },
      "expectedRefreshEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "command": {
        "type": "object",
        "properties": {
          "requestKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "results": {
            "minItems": 1,
            "maxItems": 32,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "handoffId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128,
                  "pattern": "^[A-Za-z0-9_-]+$"
                },
                "publicationDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "handoffId",
                "publicationDigest"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "requestKey",
          "results"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "schemaVersion",
      "expectedRefreshEpoch",
      "command"
    ],
    "additionalProperties": false
  },
  "checkpoint": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 2
      },
      "expectedRefreshEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "command": {
        "type": "object",
        "properties": {
          "requestKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "expectedCheckpointVersion": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "checkpoint": {
            "type": "object",
            "properties": {
              "stage": {
                "type": "string",
                "enum": [
                  "planning",
                  "working",
                  "reviewing",
                  "ready"
                ]
              },
              "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4000,
                "pattern": "\\S"
              },
              "steps": {
                "maxItems": 32,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 180,
                      "pattern": "\\S"
                    },
                    "state": {
                      "type": "string",
                      "enum": [
                        "planned",
                        "active",
                        "done",
                        "blocked"
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "title",
                    "state"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "stage",
              "summary",
              "steps"
            ],
            "additionalProperties": false
          },
          "plannerState": {
            "type": "string",
            "maxLength": 65536
          },
          "inputReceipts": {
            "maxItems": 128,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "receiptId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "receiptId",
                "digest"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "requestKey",
          "expectedCheckpointVersion",
          "checkpoint",
          "plannerState",
          "inputReceipts"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "schemaVersion",
      "expectedRefreshEpoch",
      "command"
    ],
    "additionalProperties": false
  },
  "yield": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 2
      },
      "expectedRefreshEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "command": {
        "type": "object",
        "properties": {
          "requestKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "expectedCheckpointVersion": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "checkpoint": {
            "type": "object",
            "properties": {
              "stage": {
                "type": "string",
                "enum": [
                  "planning",
                  "working",
                  "reviewing",
                  "ready"
                ]
              },
              "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4000,
                "pattern": "\\S"
              },
              "steps": {
                "maxItems": 32,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 180,
                      "pattern": "\\S"
                    },
                    "state": {
                      "type": "string",
                      "enum": [
                        "planned",
                        "active",
                        "done",
                        "blocked"
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "title",
                    "state"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "stage",
              "summary",
              "steps"
            ],
            "additionalProperties": false
          },
          "plannerState": {
            "type": "string",
            "maxLength": 65536
          },
          "inputReceipts": {
            "maxItems": 128,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "receiptId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "receiptId",
                "digest"
              ],
              "additionalProperties": false
            }
          },
          "continuation": {
            "type": "string",
            "enum": [
              "continue",
              "wait_children"
            ]
          },
          "waitFor": {
            "maxItems": 32,
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "^[A-Za-z0-9_-]+$"
            }
          }
        },
        "required": [
          "requestKey",
          "expectedCheckpointVersion",
          "checkpoint",
          "plannerState",
          "inputReceipts",
          "continuation",
          "waitFor"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "schemaVersion",
      "expectedRefreshEpoch",
      "command"
    ],
    "additionalProperties": false
  },
  "complete": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 2
      },
      "expectedRefreshEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "command": {
        "type": "object",
        "properties": {
          "requestKey": {
            "type": "string",
            "minLength": 16,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "expectedCheckpointVersion": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "inputReceipts": {
            "maxItems": 128,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "receiptId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "receiptId",
                "digest"
              ],
              "additionalProperties": false
            }
          },
          "coverage": {
            "maxItems": 32,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "taskId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128,
                  "pattern": "^[A-Za-z0-9_-]+$"
                },
                "disposition": {
                  "type": "string",
                  "enum": [
                    "advice_ready",
                    "failed",
                    "abandoned"
                  ]
                }
              },
              "required": [
                "taskId",
                "disposition"
              ],
              "additionalProperties": false
            }
          },
          "result": {
            "type": "object",
            "properties": {
              "outcome": {
                "type": "string",
                "enum": [
                  "advice_ready",
                  "blocked"
                ]
              },
              "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": 180,
                "pattern": "\\S"
              },
              "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8000,
                "pattern": "\\S"
              },
              "artifacts": {
                "maxItems": 16,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 180,
                      "pattern": "\\S"
                    },
                    "text": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 16000,
                      "pattern": "\\S"
                    }
                  },
                  "required": [
                    "id",
                    "title",
                    "text"
                  ],
                  "additionalProperties": false
                }
              },
              "evidenceValidUntil": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "outcome",
              "title",
              "summary",
              "artifacts",
              "evidenceValidUntil"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "requestKey",
          "expectedCheckpointVersion",
          "inputReceipts",
          "coverage",
          "result"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "schemaVersion",
      "expectedRefreshEpoch",
      "command"
    ],
    "additionalProperties": false
  },
  "publication": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 2
      },
      "expectedRefreshEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "publication": {
        "type": "object",
        "properties": {
          "result": {
            "type": "object",
            "properties": {
              "schemaVersion": {
                "type": "number",
                "const": 1
              },
              "resultId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "handoffId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "handoffDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "environment": {
                "type": "string",
                "enum": [
                  "simulation",
                  "development",
                  "staging",
                  "production"
                ]
              },
              "organizationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "siteId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "childTaskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "assignmentVersion": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "generation": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "authority": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "delegated"
                  },
                  "grantId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9_-]+$"
                  },
                  "grantVersion": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "revocationEpoch": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "grantDigest": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "kind",
                  "grantId",
                  "grantVersion",
                  "revocationEpoch",
                  "grantDigest"
                ],
                "additionalProperties": false
              },
              "sender": {
                "type": "object",
                "properties": {
                  "serviceId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9_-]+$"
                  },
                  "serviceVersion": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "workloadIdentityId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9_-]+$"
                  }
                },
                "required": [
                  "serviceId",
                  "serviceVersion",
                  "workloadIdentityId"
                ],
                "additionalProperties": false
              },
              "recipient": {
                "type": "object",
                "properties": {
                  "serviceId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9_-]+$"
                  },
                  "serviceVersion": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "workloadIdentityId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "^[A-Za-z0-9_-]+$"
                  }
                },
                "required": [
                  "serviceId",
                  "serviceVersion",
                  "workloadIdentityId"
                ],
                "additionalProperties": false
              },
              "attempt": {
                "type": "integer",
                "minimum": 1,
                "maximum": 4
              },
              "outcome": {
                "type": "string",
                "enum": [
                  "advice_ready",
                  "failed"
                ]
              },
              "artifacts": {
                "maxItems": 32,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "environment": {
                      "type": "string",
                      "enum": [
                        "simulation",
                        "development",
                        "staging",
                        "production"
                      ]
                    },
                    "organizationId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "siteId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "artifactId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "revision": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "digest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "environment",
                    "organizationId",
                    "siteId",
                    "artifactId",
                    "revision",
                    "digest"
                  ],
                  "additionalProperties": false
                }
              },
              "finishedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
              },
              "evidenceValidUntil": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "schemaVersion",
              "resultId",
              "handoffId",
              "handoffDigest",
              "environment",
              "organizationId",
              "siteId",
              "childTaskId",
              "assignmentVersion",
              "generation",
              "authority",
              "sender",
              "recipient",
              "attempt",
              "outcome",
              "artifacts",
              "finishedAt",
              "evidenceValidUntil"
            ],
            "additionalProperties": false
          },
          "artifacts": {
            "maxItems": 32,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "reference": {
                  "type": "object",
                  "properties": {
                    "environment": {
                      "type": "string",
                      "enum": [
                        "simulation",
                        "development",
                        "staging",
                        "production"
                      ]
                    },
                    "organizationId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "siteId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "artifactId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "^[A-Za-z0-9_-]+$"
                    },
                    "revision": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "digest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "environment",
                    "organizationId",
                    "siteId",
                    "artifactId",
                    "revision",
                    "digest"
                  ],
                  "additionalProperties": false
                },
                "body": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                }
              },
              "required": [
                "reference",
                "body"
              ],
              "additionalProperties": false
            }
          },
          "inputArtifacts": {
            "maxItems": 32,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "environment": {
                  "type": "string",
                  "enum": [
                    "simulation",
                    "development",
                    "staging",
                    "production"
                  ]
                },
                "organizationId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128,
                  "pattern": "^[A-Za-z0-9_-]+$"
                },
                "siteId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128,
                  "pattern": "^[A-Za-z0-9_-]+$"
                },
                "artifactId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128,
                  "pattern": "^[A-Za-z0-9_-]+$"
                },
                "revision": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "digest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "environment",
                "organizationId",
                "siteId",
                "artifactId",
                "revision",
                "digest"
              ],
              "additionalProperties": false
            }
          },
          "memoryUsage": {
            "maxItems": 128,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "usageId": {
                  "type": "string",
                  "format": "uuid",
                  "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                },
                "selectionDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "usageId",
                "selectionDigest"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "result",
          "artifacts",
          "inputArtifacts",
          "memoryUsage"
        ],
        "additionalProperties": false
      },
      "observations": {
        "maxItems": 3,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "requestedUrl": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "finalUrl": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "sourceDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "observedAt": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "validUntil": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
            },
            "evidenceIds": {
              "maxItems": 32,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[A-Za-z0-9_-]+$"
              }
            }
          },
          "required": [
            "requestedUrl",
            "finalUrl",
            "sourceDigest",
            "observedAt",
            "validUntil",
            "evidenceIds"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "schemaVersion",
      "expectedRefreshEpoch",
      "publication",
      "observations"
    ],
    "additionalProperties": false
  }
}
$descriptors$::jsonb->k) THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Invalid refresh command';END IF;IF k='coordinator_state' THEN PERFORM pactwoven.native_memory_require((q#>>'{usage,inputTokens}')::numeric+(q#>>'{usage,outputTokens}')::numeric=(q#>>'{usage,totalTokens}')::numeric AND(SELECT count(*)=count(DISTINCT value->>'taskId') AND count(*)=count(DISTINCT value->>'handoffId') AND count(*)=count(DISTINCT value->>'requestKey') AND count(*)=count(DISTINCT value#>>'{assignment,stepId}') FROM jsonb_array_elements(q->'slots')),'NM009');END IF;END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_work_epoch0(e text, selector jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;c pactwoven.native_delegation_root_checkpoints;historical boolean:=false;answer jsonb;BEGIN
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs
  WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO c FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,r.organization_id,r.root_task_id,r.checkpoint_version);
 IF c.version IS NOT NULL THEN
  historical:=c.generation<>(selector->>'generation')::bigint;
  BEGIN
   -- Saved planner data can contain derived text. Historical status alone is
   -- not authorization to return it after original source/reader access loss.
   PERFORM pactwoven.native_delegation_root_receipts(jsonb_set(ctx,'{usage,generation}',to_jsonb(c.generation)),c.input_receipts);
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' THEN
   c.body:=NULL;c.planner_state:=NULL;historical:=true;
  END;
 END IF;
 answer:=jsonb_build_object('title',r.title,'prompt',r.prompt,'siteId',r.site_id,
  'grant',(SELECT body FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,r.organization_id,r.grant_id)),
  'checkpointVersion',r.checkpoint_version,'checkpoint',c.body,'plannerState',c.planner_state,'historical',historical,
  'children',(SELECT coalesce(jsonb_agg(jsonb_build_object('taskId',t.id,'handoffId',t.handoff_id,'generation',t.generation,'assignmentVersion',t.assignment_version,'state',t.state,
    'publicationDigest',result.digest,'outcome',result.publication#>'{result,outcome}','assignment',a.assignment) ORDER BY t.id COLLATE "C"),'[]') FROM pactwoven.native_delegation_tasks t
    LEFT JOIN pactwoven.native_delegation_root_assignments a ON(a.environment,a.organization_id,a.task_id)=(t.environment,t.organization_id,t.id)
    LEFT JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id)
    WHERE(t.environment,t.organization_id,t.root_task_id)=(e,r.organization_id,r.root_task_id) AND t.depth>0),
  'inputReceipts',(SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId',id,'digest',digest) ORDER BY id),'[]') FROM pactwoven.native_delegation_root_inputs
    WHERE(environment,organization_id,root_task_id,generation)=(e,r.organization_id,r.root_task_id,(selector->>'generation')::bigint)),
  'memoryReferences',(SELECT memory_references FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id)));
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_materials_epoch0(e text, selector jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;a pactwoven.native_delegation_root_assignments;h jsonb;selected jsonb;artifacts jsonb;BEGIN
 ctx:=pactwoven.native_delegation_task_context_locked(e,selector,'result_publish');SELECT * INTO t FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id);
 SELECT * INTO a FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.managed AND a.task_id IS NOT NULL AND(a.generation,a.assignment_version,a.handoff_id)=(t.generation,t.assignment_version,t.handoff_id),'ND001');
 SELECT memory_references INTO selected FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id);
 PERFORM pactwoven.native_memory_require(selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.assignment->'memoryReferences') ref WHERE NOT selected @> jsonb_build_array(ref)),'ND001');
 SELECT body INTO h FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(e,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 PERFORM pactwoven.native_delegation_inputs_locked(e,t.organization_id,t.site_id,h->'inputArtifacts');
 SELECT coalesce(jsonb_agg(jsonb_build_object('reference',stored.reference,'body',stored.body) ORDER BY refs.position),'[]') INTO artifacts
  FROM jsonb_array_elements(h->'inputArtifacts') WITH ORDINALITY refs(ref,position) JOIN pactwoven.native_delegation_artifacts stored
   ON(stored.environment,stored.organization_id,stored.id,stored.revision)=(e,t.organization_id,refs.ref->>'artifactId',(refs.ref->>'revision')::bigint);
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');
 RETURN jsonb_build_object('actorId',r.actor_id,'rootTitle',r.title,'rootPrompt',r.prompt,'assignment',a.assignment,'inputArtifacts',artifacts);
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_inputs_epoch0(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_commands;r pactwoven.native_delegation_root_inputs;checked jsonb;body jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'inputs');ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO prior FROM pactwoven.native_delegation_root_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN
  PERFORM pactwoven.native_memory_require(prior.kind='inputs' AND prior.intent=q AND prior.generation=t.generation AND prior.identity=t.identity,'ND009');
  checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
  PERFORM pactwoven.native_memory_require(checked->'results'=prior.response->'results' AND checked->'dataValidUntil'=prior.response->'dataValidUntil','NM005');RETURN prior.response;
 END IF;
 PERFORM pactwoven.native_memory_require((SELECT count(*) FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id,generation)=(e,t.organization_id,t.id,t.generation))<128,'NM007');
 checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
 body:=checked||jsonb_build_object('rootTaskId',t.id,'generation',t.generation,'choices',q->'results');
 INSERT INTO pactwoven.native_delegation_root_inputs(environment,organization_id,root_task_id,generation,context_binding,body,digest,data_valid_until)
  VALUES(e,t.organization_id,t.id,t.generation,ctx-'validUntil',body,pactwoven.native_delegation_hash(body),pactwoven.native_memory_time(checked->'dataValidUntil')) RETURNING * INTO r;
 answer:=checked||jsonb_build_object('receipt',jsonb_build_object('receiptId',r.id,'digest',r.digest),'generation',t.generation);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','inputs',t.generation,t.identity,q,answer);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_checkpoint_write_epoch0(e text, selector jsonb, q jsonb, yielding boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_commands;identity jsonb;kind text;answer jsonb;continuation text;waits text[];BEGIN
 kind:=CASE WHEN yielding THEN 'yield' ELSE 'checkpoint' END;PERFORM pactwoven.native_delegation_root_require(q,kind);
 identity:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=identity,'ND001');
 PERFORM pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.native_delegation_root_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.kind=kind AND prior.intent=q AND prior.identity=identity AND prior.generation=(selector->>'generation')::bigint,'ND009');RETURN prior.response;END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint AND r.slice_count<256 AND octet_length(q->>'plannerState')<=65536,'ND009');
 PERFORM pactwoven.native_delegation_root_receipts(ctx,q->'inputReceipts');
 continuation:='running';waits:='{}';
 IF yielding THEN
  SELECT coalesce(array_agg(x ORDER BY x COLLATE "C"),'{}') INTO waits FROM jsonb_array_elements_text(q->'waitFor') x;
  PERFORM pactwoven.native_memory_require(cardinality(waits)=(SELECT count(DISTINCT x) FROM unnest(waits) x)
   AND((q->>'continuation'='continue' AND cardinality(waits)=0) OR(q->>'continuation'='wait_children' AND cardinality(waits)>0))
   AND NOT EXISTS(SELECT 1 FROM unnest(waits) w(id) LEFT JOIN pactwoven.native_delegation_tasks child ON(child.environment,child.organization_id,child.id)=(e,t.organization_id,w.id)
    WHERE child.id IS NULL OR child.root_task_id<>t.id OR child.depth=0 OR child.state IN('paused','cancelled')),'ND004');
  continuation:=CASE WHEN q->>'continuation'='continue' THEN 'yielded' ELSE 'waiting_children' END;
 END IF;
 INSERT INTO pactwoven.native_delegation_root_checkpoints(environment,organization_id,root_task_id,version,generation,body,planner_state,input_receipts)
  VALUES(e,t.organization_id,t.id,r.checkpoint_version+1,t.generation,q->'checkpoint',q->>'plannerState',q->'inputReceipts');
 UPDATE pactwoven.native_delegation_root_runs SET checkpoint_version=checkpoint_version+1,phase=continuation,wait_for=waits,slice_count=slice_count+1,updated_at=clock_timestamp()
  WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) RETURNING * INTO r;
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp(),'NM008');
 IF yielding THEN
  UPDATE pactwoven.native_delegation_tasks SET generation=generation+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id) RETURNING * INTO t;
  UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
  UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
  IF continuation='yielded' OR pactwoven.native_delegation_root_wait_ready(r) THEN PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);END IF;
 END IF;
 answer:=jsonb_build_object('checkpointVersion',r.checkpoint_version,'generation',t.generation,'attempt',t.attempt,'continuation',continuation,'requestKey',q->'requestKey');
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey',kind,(selector->>'generation')::bigint,t.identity,q,answer);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_complete_epoch0(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_completions;
 identity jsonb;coverage jsonb;deadline timestamptz;declared timestamptz;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'complete');identity:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=identity,'ND001');PERFORM pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.publication=q AND prior.generation=(selector->>'generation')::bigint,'ND009');
  RETURN jsonb_build_object('kind','duplicate','publicationDigest',prior.digest,'rootTaskId',t.id,'execution','none','domainCompletion',false);END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) AND depth>0 AND(state NOT IN('settled','cancelled') OR(state='cancelled' AND NOT EXISTS
   (SELECT 1 FROM pactwoven.native_delegation_root_dispositions d WHERE(d.environment,d.organization_id,d.task_id)=(e,t.organization_id,native_delegation_tasks.id))))),'ND009');
 coverage:=pactwoven.native_delegation_root_coverage(e,t.organization_id,t.id);PERFORM pactwoven.native_memory_require(q->'coverage'=coverage,'ND009');
 IF q#>>'{result,outcome}'='blocked' THEN PERFORM pactwoven.native_delegation_root_receipt_manifest(ctx,q->'inputReceipts');
 ELSE deadline:=pactwoven.native_delegation_root_receipts(ctx,q->'inputReceipts');END IF;
 declared:=pactwoven.native_memory_time(q#>'{result,evidenceValidUntil}');
 PERFORM pactwoven.native_memory_require((q#>>'{result,outcome}'='blocked' AND q#>'{result,artifacts}'='[]'::jsonb AND q#>'{result,evidenceValidUntil}'='null'::jsonb
   AND q#>>'{result,title}'='Work needs review' AND q#>>'{result,summary}'='The work could not be completed with current, permitted evidence.')
  OR(q#>>'{result,outcome}'='advice_ready' AND jsonb_array_length(q#>'{result,artifacts}')>0 AND declared>clock_timestamp() AND(deadline IS NULL OR declared<=deadline)),'NM008');
 PERFORM pactwoven.native_memory_require((SELECT count(*)=count(DISTINCT x->>'id') FROM jsonb_array_elements(q#>'{result,artifacts}') x),'ND004');
 -- Every successful child must actually have been consumed in this generation.
 PERFORM pactwoven.native_memory_require(q#>>'{result,outcome}'='blocked' OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_results child JOIN pactwoven.native_delegation_tasks task
  ON(task.environment,task.organization_id,task.handoff_id)=(child.environment,child.organization_id,child.handoff_id)
  WHERE(task.environment,task.organization_id,task.root_task_id)=(e,t.organization_id,t.id) AND child.publication#>>'{result,outcome}'='advice_ready'
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'choices') c
   WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=(e,t.organization_id,t.id,t.generation) AND c->>'handoffId'=child.handoff_id AND c->>'publicationDigest'=child.digest)),'NM005');
 INSERT INTO pactwoven.native_delegation_root_completions VALUES(e,t.organization_id,t.id,t.generation,q,pactwoven.native_delegation_hash(q),clock_timestamp()) RETURNING * INTO prior;
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);PERFORM pactwoven.native_memory_require((deadline IS NULL OR deadline>clock_timestamp()) AND(declared IS NULL OR declared>clock_timestamp()),'NM008');
 UPDATE pactwoven.native_delegation_root_runs SET phase=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'blocked' ELSE 'completed' END,
  reason=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'reconciliation' ELSE 'none' END,control_version=control_version+1,updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_tasks SET state='settled',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 answer:=jsonb_build_object('kind','accepted','publicationDigest',prior.digest,'rootTaskId',t.id,'execution',CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'none' ELSE 'advisory_only' END,'domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','complete',t.generation,t.identity,q,answer);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_handoff_epoch0(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;a pactwoven.native_delegation_root_assignments;selected jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'handoff');ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO a FROM pactwoven.native_delegation_root_assignments WHERE(environment,organization_id,root_task_id,request_key)=(e,r.organization_id,r.root_task_id,q->>'requestKey');
 IF FOUND THEN PERFORM pactwoven.native_memory_require(a.intent=q,'ND009');RETURN a.response;END IF;
 -- A new free-text brief could copy consumed child material without its
 -- original reader closure. Plan all assignments before consuming results.
 -- This barrier lasts for the root's lifetime, including yield/recovery;
 -- exact retained assignment replay above returns metadata only.
 PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs
  WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id)),'ND001');
 SELECT memory_references INTO selected FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,r.organization_id,r.root_task_id);
 PERFORM pactwoven.native_memory_require(selected IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q#>'{assignment,memoryReferences}') ref WHERE NOT selected @> jsonb_build_array(ref))
  AND(SELECT count(*)=count(DISTINCT x->>'memoryId') FROM jsonb_array_elements(q#>'{assignment,memoryReferences}') x)
  AND(jsonb_array_length(q#>'{assignment,memoryReferences}')=0 OR q#>>'{handoff,capability}'='read_scoped_memory'),'ND001');
 answer:=pactwoven.native_delegation_handoff(e,selector,q->'handoff');
 INSERT INTO pactwoven.native_delegation_root_assignments VALUES(e,r.organization_id,r.root_task_id,q#>>'{handoff,childTaskId}',q#>>'{handoff,handoffId}',q->>'requestKey',
  (q#>>'{handoff,assignmentVersion}')::bigint,(q#>>'{handoff,generation}')::bigint,q,q->'assignment',answer);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_handoff_epoch0(p_environment text, p_parent jsonb, p_handoff jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE c jsonb;g pactwoven.native_delegation_grants%ROWTYPE;p pactwoven.native_delegation_tasks%ROWTYPE;old pactwoven.native_delegation_envelopes%ROWTYPE;input_until timestamptz;deadline timestamptz;issued timestamptz;
BEGIN
 PERFORM pactwoven.native_delegation_require(p_handoff,'handoff');
 c:=pactwoven.native_delegation_task_context_locked(p_environment,p_parent,'result_publish');
 SELECT * INTO p FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_parent->>'organizationId',p_parent->>'taskId');
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(p.environment,p.organization_id,p.grant_id);
 IF(p_handoff->>'environment',p_handoff->>'organizationId',p_handoff->>'siteId',p_handoff->>'rootTaskId',p_handoff->>'parentTaskId') IS DISTINCT FROM(p.environment,p.organization_id,p.site_id,p.root_task_id,p.id)
  OR p_handoff->'authority' IS DISTINCT FROM p.authority OR p_handoff->'sender' IS DISTINCT FROM p.identity
  OR p_handoff#>>'{sender,serviceId}'=p_handoff#>>'{recipient,serviceId}' THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Authenticated same-scope parent required'; END IF;
 SELECT * INTO old FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=
  (p.environment,p.organization_id,p_handoff->>'handoffId',(p_handoff->>'assignmentVersion')::bigint,(p_handoff->>'generation')::bigint,'handoff');
 IF FOUND THEN
  IF old.body IS DISTINCT FROM p_handoff THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Handoff envelope conflicts'; END IF;
  RETURN jsonb_build_object('kind','duplicate','execution','none','digest',old.digest);
 END IF;
 PERFORM 1 FROM pactwoven.native_delegation_services WHERE environment=p.environment AND service_id=p_handoff#>>'{recipient,serviceId}' FOR SHARE;
 deadline:=pactwoven.supplier_time(p_handoff->'deadlineAt');issued:=pactwoven.supplier_time(p_handoff->'issuedAt');
 IF p_handoff->'assignmentVersion'<>'1'::jsonb OR p_handoff->'generation'<>'1'::jsonb OR p_handoff->>'childTaskId'=ANY(p.ancestors)
  OR(p_handoff->>'depth')::integer<>p.depth+1 OR(p_handoff->>'depth')::integer>(g.body#>>'{scope,limits,maxDepth}')::integer
  OR(p_handoff->>'attemptLimit')::integer>(g.body#>>'{scope,limits,maxAttempts}')::integer
  OR(p_handoff->>'taskTimeoutMs')::integer>(g.body#>>'{scope,limits,taskTimeoutMs}')::integer
  OR NOT g.body#>'{scope,capabilities}' ? (p_handoff->>'capability')
  OR issued>clock_timestamp() OR issued<clock_timestamp()-interval '20 seconds' OR deadline<=clock_timestamp()
  OR deadline<=issued OR deadline>issued+(p_handoff->>'taskTimeoutMs')::integer*interval '1 millisecond' OR deadline>p.deadline_at
  OR g.children_created>=(g.body#>>'{scope,limits,maxChildren}')::integer OR g.active_children>=(g.body#>>'{scope,limits,maxConcurrentChildren}')::integer
  OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_services WHERE environment=p.environment AND identity=p_handoff->'recipient' AND purpose IN('coordinator','worker') AND enabled)
  OR EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE environment=p.environment AND organization_id=p.organization_id AND(id=p_handoff->>'childTaskId' OR handoff_id=p_handoff->>'handoffId')) THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Handoff limits, lineage, identity or deadline changed'; END IF;
 input_until:=pactwoven.native_delegation_inputs_locked(p.environment,p.organization_id,p.site_id,p_handoff->'inputArtifacts');
 INSERT INTO pactwoven.native_delegation_tasks(environment,organization_id,id,grant_id,site_id,root_task_id,parent_task_id,handoff_id,ancestors,depth,identity,authority,capability,state,attempt_limit,deadline_at)
  VALUES(p.environment,p.organization_id,p_handoff->>'childTaskId',g.id,p.site_id,p.root_task_id,p.id,p_handoff->>'handoffId',p.ancestors||ARRAY[p_handoff->>'childTaskId'],p.depth+1,p_handoff->'recipient',p.authority,p_handoff->>'capability','ready',(p_handoff->>'attemptLimit')::integer,deadline);
 INSERT INTO pactwoven.native_delegation_envelopes VALUES(p.environment,p.organization_id,p_handoff->>'handoffId',1,1,'handoff',p_handoff);
 INSERT INTO pactwoven.native_delegation_outbox(environment,organization_id,task_id,generation) VALUES(p.environment,p.organization_id,p_handoff->>'childTaskId',1);
 UPDATE pactwoven.native_delegation_grants SET children_created=children_created+1,active_children=active_children+1 WHERE(environment,organization_id,id)=(g.environment,g.organization_id,g.id);
 IF pactwoven.supplier_time(c->'validUntil')<=clock_timestamp() OR deadline<=clock_timestamp() OR(input_until IS NOT NULL AND input_until<=clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Handoff authority expired while reserving'; END IF;
 RETURN jsonb_build_object('kind','accepted','execution','advisory_only','digest',pactwoven.native_delegation_hash(p_handoff));
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_retry_epoch0(p_environment text, p_parent jsonb, p_handoff jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE c jsonb;p pactwoven.native_delegation_tasks%ROWTYPE;t pactwoven.native_delegation_tasks%ROWTYPE;old jsonb;u timestamptz;
BEGIN
 PERFORM pactwoven.native_delegation_require(p_handoff,'handoff');c:=pactwoven.native_delegation_task_context_locked(p_environment,p_parent,'result_publish');
 SELECT * INTO p FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,p_parent->>'organizationId',p_parent->>'taskId');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,handoff_id)=(p.environment,p.organization_id,p_handoff->>'handoffId') FOR UPDATE;
 IF t.id IS NULL OR t.parent_task_id<>p.id OR t.identity IS DISTINCT FROM p_handoff->'recipient' THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Retained parent assignment required'; END IF;
 SELECT body INTO old FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 IF p_handoff=old THEN RETURN jsonb_build_object('kind','duplicate','execution','none','digest',pactwoven.native_delegation_hash(old)); END IF;
 IF(p_handoff-'generation') IS DISTINCT FROM(old-'generation') OR(p_handoff->>'generation')::bigint<>t.generation+1
  OR t.state<>'running' OR t.lease_until>clock_timestamp() OR t.attempt>=t.attempt_limit OR t.deadline_at<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,parent_task_id)=(t.environment,t.organization_id,t.id)) THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Bounded fenced retry required'; END IF;
 u:=pactwoven.native_delegation_inputs_locked(t.environment,t.organization_id,t.site_id,p_handoff->'inputArtifacts');
 UPDATE pactwoven.native_delegation_tasks SET state='ready',generation=generation+1,attempt=attempt+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.id) RETURNING * INTO t;
 INSERT INTO pactwoven.native_delegation_envelopes VALUES(t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff',p_handoff);
 INSERT INTO pactwoven.native_delegation_outbox(environment,organization_id,task_id,generation) VALUES(t.environment,t.organization_id,t.id,t.generation);
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=(t.environment,t.organization_id,t.id);
 IF pactwoven.supplier_time(c->'validUntil')<=clock_timestamp() OR t.deadline_at<=clock_timestamp() OR(u IS NOT NULL AND u<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Retry authority expired'; END IF;
 RETURN jsonb_build_object('kind','accepted','execution','advisory_only','digest',pactwoven.native_delegation_hash(p_handoff));
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_result_commit_epoch0(p_environment text, p_selector jsonb, p_publication jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE c jsonb;service jsonb;r jsonb;g pactwoven.native_delegation_grants%ROWTYPE;t pactwoven.native_delegation_tasks%ROWTYPE;h pactwoven.native_delegation_envelopes%ROWTYPE;
 prior pactwoven.native_delegation_results%ROWTYPE;artifact jsonb;ref jsonb;publication_digest text;u timestamptz;finished timestamptz;evidence_until timestamptz;ignored jsonb;
BEGIN
 service:=pactwoven.native_delegation_service(p_environment,ARRAY['coordinator','worker']);PERFORM pactwoven.native_delegation_target(p_selector,true);
 IF NOT pactwoven.supplier_object(p_publication,ARRAY['result','artifacts','inputArtifacts','memoryUsage']) OR octet_length(p_publication::text)>524288
  OR jsonb_typeof(p_publication->'artifacts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_publication->'artifacts')>32
  OR jsonb_typeof(p_publication->'inputArtifacts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_publication->'inputArtifacts')>32
  OR jsonb_typeof(p_publication->'memoryUsage') IS DISTINCT FROM 'array' OR jsonb_array_length(p_publication->'memoryUsage')>128 THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Normalized result publication required'; END IF;
 r:=p_publication->'result';PERFORM pactwoven.native_delegation_require(r,'result');
 IF(r->>'environment',r->>'organizationId',r->>'childTaskId',r->>'handoffId',r->>'generation') IS DISTINCT FROM(p_environment,p_selector->>'organizationId',p_selector->>'taskId',p_selector->>'handoffId',p_selector->>'generation')
  OR r->'sender' IS DISTINCT FROM service THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Authenticated assigned result sender required'; END IF;
 publication_digest:=pactwoven.native_delegation_hash(p_publication);
 SELECT * INTO prior FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(p_environment,r->>'organizationId',r->>'handoffId');
 IF FOUND THEN
  IF prior.publication IS DISTINCT FROM p_publication THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Accepted result conflicts'; END IF;
  RETURN jsonb_build_object('kind','duplicate','execution','none','publicationDigest',prior.digest,'domainCompletion',false);
 END IF;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,r->>'organizationId',r->>'childTaskId');
 IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Assigned result task required'; END IF;
 g:=pactwoven.native_delegation_grant_locked(t.environment,t.organization_id,t.grant_id);
 -- Grant lock serializes a concurrent unknown-ACK duplicate before inspection.
 SELECT * INTO prior FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(p_environment,r->>'organizationId',r->>'handoffId');
 IF FOUND THEN
  IF prior.publication IS DISTINCT FROM p_publication THEN RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Accepted result conflicts'; END IF;
  RETURN jsonb_build_object('kind','duplicate','execution','none','publicationDigest',prior.digest,'domainCompletion',false);
 END IF;
 c:=pactwoven.native_delegation_task_context_locked(p_environment,p_selector,'result_publish');
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(p_environment,r->>'organizationId',r->>'childTaskId');
 SELECT * INTO h FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(t.environment,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 finished:=pactwoven.supplier_time(r->'finishedAt');evidence_until:=CASE WHEN r->'evidenceValidUntil'<>'null'::jsonb THEN pactwoven.supplier_time(r->'evidenceValidUntil') END;
 IF h.handoff_id IS NULL OR r->'authority' IS DISTINCT FROM t.authority OR r->'recipient' IS DISTINCT FROM h.body->'sender'
  OR r->>'handoffDigest'<>h.digest OR(r->>'assignmentVersion')::bigint<>t.assignment_version OR(r->>'attempt')::integer<>t.attempt
  OR p_publication->'inputArtifacts' IS DISTINCT FROM h.body->'inputArtifacts'
  OR finished>clock_timestamp() OR finished<pactwoven.supplier_time(h.body->'issuedAt') OR finished>=t.deadline_at
  OR jsonb_array_length(r->'artifacts')<>(SELECT count(DISTINCT value->>'artifactId') FROM jsonb_array_elements(r->'artifacts'))
  OR(r->>'outcome'='advice_ready' AND(jsonb_array_length(r->'artifacts')=0 OR evidence_until IS NULL OR evidence_until<=clock_timestamp()))
  OR(r->>'outcome'='failed' AND(jsonb_array_length(r->'artifacts')<>0 OR r->'evidenceValidUntil'<>'null'::jsonb))
  OR jsonb_array_length(p_publication->'artifacts')<>jsonb_array_length(r->'artifacts')
  OR EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,parent_task_id)=(t.environment,t.organization_id,t.id) AND state<>'settled') THEN
  RAISE EXCEPTION USING ERRCODE='ND009',MESSAGE='Exact current advisory result required'; END IF;
 u:=pactwoven.native_delegation_inputs_locked(t.environment,t.organization_id,t.site_id,h.body->'inputArtifacts');
 IF u IS NOT NULL AND evidence_until>u THEN RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Result evidence outlives inputs'; END IF;
 FOR artifact IN SELECT value FROM jsonb_array_elements(p_publication->'artifacts') LOOP
  IF NOT pactwoven.supplier_object(artifact,ARRAY['reference','body']) OR jsonb_typeof(artifact->'body') IS DISTINCT FROM 'object' OR octet_length((artifact->'body')::text)>65536 THEN
   RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Artifact body required'; END IF;
  ref:=artifact->'reference';
  IF NOT r->'artifacts' @> jsonb_build_array(ref) OR(ref->>'environment',ref->>'organizationId',ref->>'siteId') IS DISTINCT FROM(t.environment,t.organization_id,t.site_id)
   OR coalesce(ref->>'digest','')<>pactwoven.native_delegation_hash(artifact->'body') THEN RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Artifact hash or scope mismatch'; END IF;
 END LOOP;
 IF(SELECT coalesce(jsonb_agg(value->'reference' ORDER BY ordinality),'[]'::jsonb) FROM jsonb_array_elements(p_publication->'artifacts') WITH ORDINALITY) IS DISTINCT FROM r->'artifacts' THEN
  RAISE EXCEPTION USING ERRCODE='ND004',MESSAGE='Exact ordered artifact bodies required'; END IF;
 -- Both helpers must exist together. Static names cannot be chosen by a caller.
 IF to_regprocedure('pactwoven.native_memory_assert_usage_locked(text,jsonb,jsonb,text)') IS NOT NULL
  AND to_regprocedure('pactwoven.native_memory_bind_artifact_locked(text,jsonb,jsonb,text)') IS NOT NULL THEN
  EXECUTE 'SELECT pactwoven.native_memory_assert_usage_locked($1,$2,$3,$4)' INTO ignored USING p_environment,c,p_publication->'memoryUsage',publication_digest;
  IF jsonb_array_length(p_publication->'memoryUsage')>0 THEN
   -- Source eligibility and provider authority have distinct clocks. Require
   -- the data-only closure deadline from the memory seam; an older seam that
   -- omits it fails closed rather than advertising evidence beyond its source.
   IF jsonb_typeof(ignored->'dataValidUntil') IS DISTINCT FROM 'string' OR pactwoven.supplier_time(ignored->'dataValidUntil')<=clock_timestamp()
    OR(evidence_until IS NOT NULL AND evidence_until>pactwoven.supplier_time(ignored->'dataValidUntil')) THEN
    RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Result evidence outlives original memory data'; END IF;
  END IF;
 ELSIF p_publication->'memoryUsage'<>'[]'::jsonb OR to_regprocedure('pactwoven.native_memory_assert_usage_locked(text,jsonb,jsonb,text)') IS NOT NULL
  OR to_regprocedure('pactwoven.native_memory_bind_artifact_locked(text,jsonb,jsonb,text)') IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Memory provenance validation unavailable'; END IF;
 INSERT INTO pactwoven.native_delegation_results(environment,organization_id,handoff_id,result_id,assignment_version,generation,publication)
  VALUES(t.environment,t.organization_id,t.handoff_id,r->>'resultId',t.assignment_version,t.generation,p_publication);
 FOR artifact IN SELECT value FROM jsonb_array_elements(p_publication->'artifacts') LOOP
  ref:=artifact->'reference';
  INSERT INTO pactwoven.native_delegation_artifacts VALUES(t.environment,t.organization_id,ref->>'artifactId',(ref->>'revision')::bigint,t.site_id,t.id,ref,artifact->'body',evidence_until,
   p_publication->'memoryUsage'<>'[]'::jsonb,publication_digest);
 END LOOP;
 IF to_regprocedure('pactwoven.native_memory_bind_artifact_locked(text,jsonb,jsonb,text)') IS NOT NULL THEN
  EXECUTE 'SELECT pactwoven.native_memory_bind_artifact_locked($1,$2,$3,$4)' INTO ignored USING p_environment,c,p_publication->'memoryUsage',publication_digest;
 END IF;
 -- Re-observe deadlines after memory locks and all writes; exceptions roll back
 -- result, artifact, provenance binding and counters together.
 PERFORM pactwoven.native_delegation_task_context_locked(p_environment,p_selector,'result_publish');
 IF pactwoven.supplier_time(c->'validUntil')<=clock_timestamp() OR(u IS NOT NULL AND u<=clock_timestamp()) OR(evidence_until IS NOT NULL AND evidence_until<=clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='ND001',MESSAGE='Result authority expired while publishing'; END IF;
 UPDATE pactwoven.native_delegation_tasks SET state='settled',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_grants SET active_children=active_children-1 WHERE(environment,organization_id,id)=(t.environment,t.organization_id,t.grant_id);
 RETURN jsonb_build_object('kind','accepted','execution','advisory_only','publicationDigest',publication_digest,'domainCompletion',false);
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_fence_epoch0(r pactwoven.native_delegation_root_runs, why text, root_state text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 PERFORM 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) ORDER BY id COLLATE "C" FOR UPDATE;
 INSERT INTO pactwoven.native_delegation_root_dispositions(environment,organization_id,root_task_id,task_id,generation,reason)
  SELECT environment,organization_id,root_task_id,id,generation,why FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) AND depth>0 AND state NOT IN('settled','cancelled') ON CONFLICT DO NOTHING;
 UPDATE pactwoven.native_delegation_tasks SET state=CASE WHEN depth=0 THEN root_state ELSE 'cancelled' END,generation=generation+1,lease_token=NULL,lease_until=NULL
  WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id) AND state NOT IN('settled','cancelled');
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1
  WHERE(environment,organization_id)=(r.environment,r.organization_id) AND task_id IN(SELECT id FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id));
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id)=(r.environment,r.organization_id)
  AND task_id IN(SELECT id FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,r.root_task_id));
 UPDATE pactwoven.native_delegation_grants SET active_children=0 WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id);
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_epoch(e text,o text,r text) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT epoch FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=($1,$2,$3)),0) $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_legacy(e text,selector jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_delegation_tasks;BEGIN
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.root_task_id)=0,'ND001');END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_pending(e text,o text,r text) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT count(DISTINCT l.task_id)::integer FROM pactwoven.native_delegation_refresh_lineages l
 WHERE(l.environment,l.organization_id,l.root_task_id)=($1,$2,$3) AND l.kind='replacement' AND NOT EXISTS(
 SELECT 1 FROM pactwoven.native_delegation_tasks t WHERE(t.environment,t.organization_id,t.id)=(l.environment,l.organization_id,l.task_id)) $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_slots(e text,o text,r text,ep bigint) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(v.body ORDER BY v.logical_task_id COLLATE "C"),'[]') FROM(
 SELECT DISTINCT ON(l.logical_task_id COLLATE "C") l.logical_task_id,l.body FROM pactwoven.native_delegation_refresh_lineages l
 WHERE(l.environment,l.organization_id,l.root_task_id,l.epoch)=($1,$2,$3,$4) ORDER BY l.logical_task_id COLLATE "C",l.revision DESC) v $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_manifest(e text,o text,r text,ep bigint) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;d text;BEGIN s:=pactwoven.native_delegation_refresh_slots(e,o,r,ep);d:=pactwoven.native_delegation_hash(s);
 INSERT INTO pactwoven.native_delegation_refresh_manifests VALUES(e,o,r,ep,d,s) ON CONFLICT DO NOTHING;
 INSERT INTO pactwoven.native_delegation_refresh_current VALUES(e,o,r,ep,d) ON CONFLICT(environment,organization_id,root_task_id) DO UPDATE SET epoch=EXCLUDED.epoch,lineage_digest=EXCLUDED.lineage_digest;
 RETURN d;END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c pactwoven.native_delegation_refresh_current;BEGIN
 IF NEW.depth=0 THEN SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(NEW.environment,NEW.organization_id,NEW.id);
 IF FOUND THEN INSERT INTO pactwoven.native_delegation_refresh_generations VALUES(NEW.environment,NEW.organization_id,NEW.id,NEW.generation,c.epoch,c.lineage_digest) ON CONFLICT DO NOTHING;
 PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_generations g WHERE(g.environment,g.organization_id,g.root_task_id,g.generation,g.epoch,g.lineage_digest)=(NEW.environment,NEW.organization_id,NEW.id,NEW.generation,c.epoch,c.lineage_digest)),'ND009');END IF;END IF;RETURN NEW;END $$;
DROP TRIGGER IF EXISTS native_refresh_generation ON pactwoven.native_delegation_tasks;
CREATE TRIGGER native_refresh_generation AFTER UPDATE OF generation ON pactwoven.native_delegation_tasks FOR EACH ROW WHEN(OLD.generation IS DISTINCT FROM NEW.generation) EXECUTE FUNCTION pactwoven.native_delegation_refresh_generation();
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_choices(ctx jsonb,choices jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b pactwoven.native_delegation_refresh_generations;m pactwoven.native_delegation_refresh_manifests;x jsonb;BEGIN
 SELECT * INTO b FROM pactwoven.native_delegation_refresh_generations WHERE(environment,organization_id,root_task_id,generation)=(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',(ctx#>>'{usage,generation}')::bigint);
 IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO m FROM pactwoven.native_delegation_refresh_manifests WHERE(environment,organization_id,root_task_id,epoch,digest)=(b.environment,b.organization_id,b.root_task_id,b.epoch,b.lineage_digest);
 PERFORM pactwoven.native_memory_require(m.digest=pactwoven.native_delegation_hash(m.slots),'NM009');
 FOR x IN SELECT value FROM jsonb_array_elements(choices) LOOP
 PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM jsonb_array_elements(m.slots) s WHERE s->>'handoffId'=x->>'handoffId'),'NM005');END LOOP;END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_key(e text,selector jsonb,q jsonb,kind text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT 'c3_'||pactwoven.native_delegation_hash(jsonb_build_object('domain',CASE WHEN $4='refresh' THEN 'pactwoven.native.refresh.v2' ELSE 'pactwoven.native.refresh-dispatch.v2' END,
 'environment',$1,'organizationId',$2->>'organizationId','rootTaskId',$2->>'taskId','generation',($2->>'generation')::bigint,'command',$3-'requestKey')) $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_command_lookup(e text,selector jsonb,q jsonb,kind text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_delegation_tasks;s jsonb;p pactwoven.native_delegation_refresh_commands;BEGIN
 s:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=s,'ND001');
 -- The stable grant row lock serializes metadata lookup even after original authority was revoked.
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id) FOR UPDATE;
 PERFORM pactwoven.native_memory_require(q->>'requestKey'=pactwoven.native_delegation_refresh_key(e,selector,q,kind),'ND004');
 SELECT * INTO p FROM pactwoven.native_delegation_refresh_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN PERFORM pactwoven.native_memory_require(p.identity=s AND p.kind=kind AND p.generation=(selector->>'generation')::bigint AND p.intent=q AND p.intent_digest=pactwoven.native_delegation_hash(q),'ND009');RETURN p.response;END IF;RETURN NULL;END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_input_binding(ctx jsonb,input_body jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b pactwoven.native_delegation_refresh_generations;BEGIN SELECT * INTO b FROM pactwoven.native_delegation_refresh_generations
 WHERE(environment,organization_id,root_task_id,generation)=(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',(ctx#>>'{usage,generation}')::bigint);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(input_body->>'refreshEpoch'=b.epoch::text AND input_body->>'lineageDigest'=b.lineage_digest,'NM009');END IF;END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_covered(ctx jsonb,old_task text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE next_task(id,depth) AS(SELECT old_task,0 UNION ALL
 SELECT l.task_id,n.depth+1 FROM next_task n JOIN pactwoven.native_delegation_refresh_lineages l ON l.body->>'predecessorTaskId'=n.id AND l.task_id<>n.id
 WHERE(l.environment,l.organization_id,l.root_task_id)=(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}') AND n.depth<32)
 SELECT EXISTS(SELECT 1 FROM next_task n JOIN pactwoven.native_delegation_refresh_generations g
 ON(g.environment,g.organization_id,g.root_task_id,g.generation)=(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',(ctx#>>'{usage,generation}')::bigint)
 JOIN pactwoven.native_delegation_refresh_manifests m ON(m.environment,m.organization_id,m.root_task_id,m.epoch,m.digest)=(g.environment,g.organization_id,g.root_task_id,g.epoch,g.lineage_digest)
 JOIN pactwoven.native_delegation_tasks t ON(t.environment,t.organization_id,t.id)=(g.environment,g.organization_id,n.id)
 JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id)
 WHERE n.depth>0 AND result.publication#>>'{result,outcome}'='advice_ready' AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.slots) s WHERE s->>'taskId'=n.id)
 AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'choices') c
 WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=(g.environment,g.organization_id,g.root_task_id,g.generation) AND c->>'handoffId'=result.handoff_id AND c->>'publicationDigest'=result.digest)) $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_current_complete(ctx jsonb,blocked boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE slots jsonb;s jsonb;t pactwoven.native_delegation_tasks;ep bigint;BEGIN
 ep:=pactwoven.native_delegation_refresh_epoch(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}');IF ep=0 THEN RETURN;END IF;
 slots:=pactwoven.native_delegation_refresh_slots(ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',ep);
 FOR s IN SELECT value FROM jsonb_array_elements(slots) LOOP
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(ctx->>'environment',ctx->>'organizationId',s->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.state IN('settled','cancelled'),'ND009');
 IF NOT blocked THEN PERFORM pactwoven.native_memory_require(t.state='settled' AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_results result
 WHERE(result.environment,result.organization_id,result.handoff_id)=(t.environment,t.organization_id,t.handoff_id) AND result.publication#>>'{result,outcome}'='advice_ready'),'NM005');END IF;
 END LOOP;END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_work_v2(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE work jsonb;c pactwoven.native_delegation_refresh_current;ep pactwoven.native_delegation_refresh_epochs;slots jsonb;s jsonb;out_slots jsonb:='[]';usage jsonb;state jsonb;operations jsonb;BEGIN
 work:=pactwoven.native_delegation_root_work_epoch0(e,selector);
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,selector->>'organizationId',selector->>'taskId');
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',0,'work',work,'refresh',NULL);END IF;
 SELECT * INTO ep FROM pactwoven.native_delegation_refresh_epochs WHERE(environment,organization_id,root_task_id,epoch)=(c.environment,c.organization_id,c.root_task_id,c.epoch);
 slots:=pactwoven.native_delegation_refresh_slots(c.environment,c.organization_id,c.root_task_id,c.epoch);
 PERFORM pactwoven.native_memory_require(c.lineage_digest=pactwoven.native_delegation_hash(slots),'NM009');
 FOR s IN SELECT value FROM jsonb_array_elements(slots) LOOP
 out_slots:=out_slots||jsonb_build_array(s||jsonb_build_object('admission',CASE WHEN EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,c.organization_id,s->>'taskId')) THEN 'admitted'
 WHEN EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_dispositions WHERE(environment,organization_id,root_task_id,task_id)=(e,c.organization_id,c.root_task_id,s->>'taskId')) THEN 'abandoned' ELSE 'pending' END));END LOOP;
 usage:=ep.usage;
 BEGIN state:=(SELECT planner_state::jsonb FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,c.organization_id,c.root_task_id,(work->>'checkpointVersion')::bigint));
 PERFORM pactwoven.native_delegation_refresh_require(state,'coordinator_state');usage:=state->'usage';EXCEPTION WHEN invalid_text_representation OR SQLSTATE 'ND004' THEN NULL;END;
 SELECT coalesce(jsonb_agg(response ORDER BY recorded_at,request_key COLLATE "C"),'[]') INTO operations FROM pactwoven.native_delegation_refresh_commands WHERE(environment,organization_id,root_task_id)=(e,c.organization_id,c.root_task_id);
 RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',c.epoch,'work',work,'refresh',jsonb_build_object('lineageDigest',c.lineage_digest,'planBasis',ep.original_plan,'slots',out_slots,'usage',usage,'operations',operations));END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_materials_v2(e text,selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE material jsonb;t pactwoven.native_delegation_tasks;c pactwoven.native_delegation_refresh_current;s jsonb;original_digest text;BEGIN
 material:=pactwoven.native_delegation_root_materials_epoch0(e,selector);SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id);
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',0,'material',material,'refresh',NULL);END IF;
 SELECT value INTO s FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.root_task_id,c.epoch)) WHERE value->>'taskId'=t.id;
 PERFORM pactwoven.native_memory_require(s IS NOT NULL AND s->>'handoffId'=t.handoff_id,'ND001');
 SELECT result.digest INTO original_digest FROM pactwoven.native_delegation_tasks original JOIN pactwoven.native_delegation_results result ON(result.environment,result.organization_id,result.handoff_id)=(original.environment,original.organization_id,original.handoff_id)
 WHERE(original.environment,original.organization_id,original.id)=(e,t.organization_id,coalesce(s->>'predecessorTaskId',s->>'originalTaskId'));
 RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',c.epoch,'material',material,'refresh',jsonb_build_object('lineageDigest',c.lineage_digest,'logicalTaskId',s->>'logicalTaskId','originalTaskId',s->>'originalTaskId',
 'originalPublicationDigest',original_digest,'requiresPublicObservation',s->>'kind'='replacement' AND t.capability='research_public_sources'));END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_validate_inputs(ctx jsonb, choices jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE choice jsonb;result pactwoven.native_delegation_results;t pactwoven.native_delegation_tasks;
 a pactwoven.native_delegation_artifacts;u pactwoven.native_memory_usages;bound_ctx jsonb;checked jsonb;root_checked jsonb;artifacts jsonb;items jsonb:='[]';until_time timestamptz;usage_count integer:=0;BEGIN
 PERFORM pactwoven.native_delegation_refresh_choices(ctx,choices);
 PERFORM pactwoven.native_memory_require(jsonb_typeof(choices)='array' AND jsonb_array_length(choices) BETWEEN 1 AND 32 AND
  (SELECT count(*)=count(DISTINCT x->>'handoffId') FROM jsonb_array_elements(choices) x),'ND004');
 FOR choice IN SELECT x FROM jsonb_array_elements(choices) x LOOP
  SELECT * INTO result FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(ctx->>'environment',ctx->>'organizationId',choice->>'handoffId');
  SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,handoff_id)=(ctx->>'environment',ctx->>'organizationId',choice->>'handoffId');
  PERFORM pactwoven.native_memory_require(result.handoff_id IS NOT NULL AND result.digest=choice->>'publicationDigest' AND t.root_task_id=ctx#>>'{usage,taskId}'
   AND t.depth>0 AND t.state='settled' AND t.site_id=ctx->>'siteId' AND t.authority=ctx->'authority'
   AND(t.generation,t.assignment_version)=(result.generation,result.assignment_version),'ND001');
  artifacts:='[]';
  FOR a IN SELECT stored.* FROM jsonb_array_elements(result.publication->'artifacts') WITH ORDINALITY item(value,position)
   JOIN pactwoven.native_delegation_artifacts stored ON(stored.environment,stored.organization_id,stored.id,stored.revision)=
    (t.environment,t.organization_id,item.value#>>'{reference,artifactId}',(item.value#>>'{reference,revision}')::bigint) ORDER BY item.position LOOP
   PERFORM pactwoven.native_memory_require(a.task_id=t.id AND a.site_id=t.site_id AND a.publication_digest=result.digest AND a.valid_until>clock_timestamp()
    AND a.reference->>'digest'=pactwoven.native_delegation_hash(a.body),'NM008');
   artifacts:=artifacts||jsonb_build_array(jsonb_build_object('reference',a.reference,'body',a.body));until_time:=least(until_time,a.valid_until);
  END LOOP;
  PERFORM pactwoven.native_memory_require(artifacts=result.publication->'artifacts','NM009');
  IF jsonb_array_length(result.publication->'memoryUsage')>0 THEN
   PERFORM pactwoven.native_memory_require(ctx->'authority'=t.authority AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_grants g
    WHERE(g.environment,g.organization_id,g.id)=(t.environment,t.organization_id,t.grant_id) AND g.body#>'{scope,capabilities}' ? 'read_scoped_memory'),'ND001');
   SELECT * INTO u FROM pactwoven.native_memory_usages WHERE id=(result.publication#>>'{memoryUsage,0,usageId}')::uuid;
   PERFORM pactwoven.native_memory_require(u.id IS NOT NULL AND(u.environment,u.organization_id,u.site_id)=(t.environment,t.organization_id,t.site_id)
    AND u.context#>>'{usage,taskId}'=t.id AND u.context#>>'{usage,handoffId}'=t.handoff_id AND u.context#>>'{usage,generation}'=t.generation::text
    AND u.publication_digest=result.digest,'NM009');
   bound_ctx:=u.context_binding||jsonb_build_object('validUntil',ctx->'validUntil');
   checked:=pactwoven.native_memory_assert_usage_locked(t.environment,bound_ctx,result.publication->'memoryUsage',result.digest);
   until_time:=least(until_time,pactwoven.native_memory_time(checked->'dataValidUntil'));usage_count:=usage_count+(checked->>'usageCount')::integer;
   PERFORM pactwoven.native_memory_require(usage_count<=128,'NM007');
   FOR u IN SELECT * FROM pactwoven.native_memory_usages WHERE(environment,organization_id,site_id)=(t.environment,t.organization_id,t.site_id)
    AND context->'usage'=bound_ctx->'usage' ORDER BY id LOOP
    -- Re-evaluate the same immutable closure using the root's own reader ACL.
    -- This creates no ordinary memory usage or invented root handoff.
    root_checked:=pactwoven.native_memory_evaluate_locked(pactwoven.native_memory_data_context(ctx),u.selection->'root',date_trunc('milliseconds',clock_timestamp()));
    PERFORM pactwoven.native_memory_require(root_checked#>'{selection,memories}'=u.selection->'memories'
     AND root_checked#>'{selection,sources}'=u.selection->'sources','NM005');
    until_time:=least(until_time,pactwoven.native_memory_time(root_checked#>'{selection,validUntil}'));
   END LOOP;
  ELSE
   PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_memory_usages WHERE(environment,organization_id,site_id)=(t.environment,t.organization_id,t.site_id)
    AND context#>>'{usage,taskId}'=t.id AND context#>>'{usage,handoffId}'=t.handoff_id AND context#>>'{usage,generation}'=t.generation::text),'NM009');
  END IF;
  items:=items||jsonb_build_array(jsonb_build_object('handoffId',t.handoff_id,'publicationDigest',result.digest,'outcome',result.publication#>'{result,outcome}','artifacts',artifacts));
 END LOOP;
 PERFORM pactwoven.native_memory_require(octet_length(items::text)<=524288 AND pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp()
  AND(until_time IS NULL OR until_time>clock_timestamp()),'NM008');
 RETURN jsonb_build_object('results',items,'dataValidUntil',CASE WHEN until_time IS NOT NULL THEN pactwoven.mandate_instant(until_time) END);
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_receipts(ctx jsonb, refs jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE r pactwoven.native_delegation_root_inputs;checked jsonb;deadline timestamptz;BEGIN
 PERFORM pactwoven.native_delegation_root_receipt_manifest(ctx,refs);
 FOR r IN SELECT * FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id,generation)=
  (ctx->>'environment',ctx->>'organizationId',ctx#>>'{usage,taskId}',(ctx#>>'{usage,generation}')::bigint) ORDER BY id LOOP
  PERFORM pactwoven.native_memory_require(r.context_binding=ctx-'validUntil','NM005');
  PERFORM pactwoven.native_delegation_refresh_input_binding(ctx,r.body);
  checked:=pactwoven.native_delegation_root_validate_inputs(ctx,r.body->'choices');
  PERFORM pactwoven.native_memory_require(checked->'results'=r.body->'results' AND checked->'dataValidUntil'=r.body->'dataValidUntil','NM005');
  deadline:=least(deadline,r.data_valid_until);
 END LOOP;
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp() AND(deadline IS NULL OR deadline>clock_timestamp()),'NM008');RETURN deadline;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_inputs_c3(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_commands;r pactwoven.native_delegation_root_inputs;checked jsonb;body jsonb;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'inputs');ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO prior FROM pactwoven.native_delegation_root_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF FOUND THEN
  PERFORM pactwoven.native_memory_require(prior.kind='inputs' AND prior.intent=q AND prior.generation=t.generation AND prior.identity=t.identity,'ND009');
  checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
  PERFORM pactwoven.native_memory_require(checked->'results'=prior.response->'results' AND checked->'dataValidUntil'=prior.response->'dataValidUntil','NM005');RETURN prior.response;
 END IF;
 PERFORM pactwoven.native_memory_require((SELECT count(*) FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id,generation)=(e,t.organization_id,t.id,t.generation))<128,'NM007');
 checked:=pactwoven.native_delegation_root_validate_inputs(ctx,q->'results');
 body:=checked||jsonb_build_object('rootTaskId',t.id,'generation',t.generation,'choices',q->'results');
 IF pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.id)>0 THEN body:=body||(SELECT jsonb_build_object('refreshEpoch',epoch,'lineageDigest',lineage_digest) FROM pactwoven.native_delegation_refresh_generations WHERE(environment,organization_id,root_task_id,generation)=(e,t.organization_id,t.id,t.generation));END IF;
 INSERT INTO pactwoven.native_delegation_root_inputs(environment,organization_id,root_task_id,generation,context_binding,body,digest,data_valid_until)
  VALUES(e,t.organization_id,t.id,t.generation,ctx-'validUntil',body,pactwoven.native_delegation_hash(body),pactwoven.native_memory_time(checked->'dataValidUntil')) RETURNING * INTO r;
 answer:=checked||jsonb_build_object('receipt',jsonb_build_object('receiptId',r.id,'digest',r.digest),'generation',t.generation);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','inputs',t.generation,t.identity,q,answer);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_complete_c3(e text, selector jsonb, q jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE ctx jsonb;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;prior pactwoven.native_delegation_root_completions;
 identity jsonb;coverage jsonb;deadline timestamptz;declared timestamptz;answer jsonb;BEGIN
 PERFORM pactwoven.native_delegation_root_require(q,'complete');identity:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);PERFORM pactwoven.native_delegation_target(selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=identity,'ND001');PERFORM pactwoven.native_delegation_grant_locked(e,t.organization_id,t.grant_id);
 SELECT * INTO prior FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 IF FOUND THEN PERFORM pactwoven.native_memory_require(prior.publication=q AND prior.generation=(selector->>'generation')::bigint,'ND009');
  RETURN jsonb_build_object('kind','duplicate','publicationDigest',prior.digest,'rootTaskId',t.id,'execution','none','domainCompletion',false);END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks
  WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) AND depth>0 AND(state NOT IN('settled','cancelled') OR(state='cancelled' AND NOT EXISTS
   (SELECT 1 FROM pactwoven.native_delegation_root_dispositions d WHERE(d.environment,d.organization_id,d.task_id)=(e,t.organization_id,native_delegation_tasks.id))))),'ND009');
 PERFORM pactwoven.native_delegation_refresh_current_complete(ctx,q#>>'{result,outcome}'='blocked');
 coverage:=pactwoven.native_delegation_root_coverage(e,t.organization_id,t.id);PERFORM pactwoven.native_memory_require(q->'coverage'=coverage,'ND009');
 IF q#>>'{result,outcome}'='blocked' THEN PERFORM pactwoven.native_delegation_root_receipt_manifest(ctx,q->'inputReceipts');
 ELSE deadline:=pactwoven.native_delegation_root_receipts(ctx,q->'inputReceipts');END IF;
 declared:=pactwoven.native_memory_time(q#>'{result,evidenceValidUntil}');
 PERFORM pactwoven.native_memory_require((q#>>'{result,outcome}'='blocked' AND q#>'{result,artifacts}'='[]'::jsonb AND q#>'{result,evidenceValidUntil}'='null'::jsonb
   AND q#>>'{result,title}'='Work needs review' AND q#>>'{result,summary}'='The work could not be completed with current, permitted evidence.')
  OR(q#>>'{result,outcome}'='advice_ready' AND jsonb_array_length(q#>'{result,artifacts}')>0 AND declared>clock_timestamp() AND(deadline IS NULL OR declared<=deadline)),'NM008');
 PERFORM pactwoven.native_memory_require((SELECT count(*)=count(DISTINCT x->>'id') FROM jsonb_array_elements(q#>'{result,artifacts}') x),'ND004');
 -- Every successful child must actually have been consumed in this generation.
 PERFORM pactwoven.native_memory_require(q#>>'{result,outcome}'='blocked' OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_results child JOIN pactwoven.native_delegation_tasks task
  ON(task.environment,task.organization_id,task.handoff_id)=(child.environment,child.organization_id,child.handoff_id)
  WHERE(task.environment,task.organization_id,task.root_task_id)=(e,t.organization_id,t.id) AND child.publication#>>'{result,outcome}'='advice_ready' AND NOT pactwoven.native_delegation_refresh_covered(ctx,task.id)
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i,jsonb_array_elements(i.body->'choices') c
   WHERE(i.environment,i.organization_id,i.root_task_id,i.generation)=(e,t.organization_id,t.id,t.generation) AND c->>'handoffId'=child.handoff_id AND c->>'publicationDigest'=child.digest)),'NM005');
 INSERT INTO pactwoven.native_delegation_root_completions VALUES(e,t.organization_id,t.id,t.generation,q,pactwoven.native_delegation_hash(q),clock_timestamp()) RETURNING * INTO prior;
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);PERFORM pactwoven.native_memory_require((deadline IS NULL OR deadline>clock_timestamp()) AND(declared IS NULL OR declared>clock_timestamp()),'NM008');
 UPDATE pactwoven.native_delegation_root_runs SET phase=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'blocked' ELSE 'completed' END,
  reason=CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'reconciliation' ELSE 'none' END,control_version=control_version+1,updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_tasks SET state='settled',lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 answer:=jsonb_build_object('kind','accepted','publicationDigest',prior.digest,'rootTaskId',t.id,'execution',CASE WHEN q#>>'{result,outcome}'='blocked' THEN 'none' ELSE 'advisory_only' END,'domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_root_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','complete',t.generation,t.identity,q,answer);RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_work(e text, selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(e,selector);RETURN pactwoven.native_delegation_root_work_epoch0(e,selector);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_materials(e text, selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(e,selector);RETURN pactwoven.native_delegation_root_materials_epoch0(e,selector);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_inputs(e text, selector jsonb, q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(e,selector);RETURN pactwoven.native_delegation_root_inputs_epoch0(e,selector,q);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_complete(e text, selector jsonb, q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(e,selector);RETURN pactwoven.native_delegation_root_complete_epoch0(e,selector,q);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_handoff(e text, selector jsonb, q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(e,selector);RETURN pactwoven.native_delegation_root_handoff_epoch0(e,selector,q);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_handoff(p_environment text, p_parent jsonb, p_handoff jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(p_environment,p_parent);RETURN pactwoven.native_delegation_handoff_epoch0(p_environment,p_parent,p_handoff);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_retry(p_environment text, p_parent jsonb, p_handoff jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(p_environment,p_parent);RETURN pactwoven.native_delegation_retry_epoch0(p_environment,p_parent,p_handoff);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_result_commit(p_environment text, p_selector jsonb, p_publication jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(p_environment,p_selector);RETURN pactwoven.native_delegation_result_commit_epoch0(p_environment,p_selector,p_publication);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_checkpoint(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(e,selector);RETURN pactwoven.native_delegation_root_checkpoint_write_epoch0(e,selector,q,false);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_yield(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM pactwoven.native_delegation_refresh_legacy(e,selector);RETURN pactwoven.native_delegation_root_checkpoint_write_epoch0(e,selector,q,true);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_inputs_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_delegation_refresh_require(q,'inputs');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_inputs_c3(e,selector,q->'command');RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_checkpoint_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_delegation_refresh_require(q,'checkpoint');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_checkpoint_write_epoch0(e,selector,q->'command',false);RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_yield_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_delegation_refresh_require(q,'yield');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_checkpoint_write_epoch0(e,selector,q->'command',true);RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_complete_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE ep bigint;receipt jsonb;BEGIN PERFORM pactwoven.native_delegation_refresh_require(q,'complete');ep:=pactwoven.native_delegation_refresh_epoch(e,selector->>'organizationId',selector->>'taskId');PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint,'ND009');receipt:=pactwoven.native_delegation_root_complete_c3(e,selector,q->'command'); IF ep>0 THEN INSERT INTO pactwoven.native_delegation_refresh_completions SELECT e,selector->>'organizationId',selector->>'taskId',ep,c.lineage_digest,(selector->>'generation')::bigint,receipt->>'publicationDigest' FROM pactwoven.native_delegation_refresh_current c WHERE(c.environment,c.organization_id,c.root_task_id)=(e,selector->>'organizationId',selector->>'taskId') ON CONFLICT DO NOTHING;END IF;RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'receipt',receipt);END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_read(p_actor jsonb, p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;g pactwoven.native_delegation_grants;c pactwoven.native_delegation_root_checkpoints;
 input pactwoven.native_delegation_root_inputs;ctx jsonb;projection_ctx jsonb;checked jsonb;result_body jsonb;state text;reason text;unavailable boolean:=false;deadline timestamptz;projection_until timestamptz;BEGIN
 PERFORM pactwoven.native_delegation_actor_locked(p_actor,NULL,false);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id,actor_id)=(p_actor->>'environment',p_actor->>'organizationId',p_id,p_actor->>'actorId');
 PERFORM pactwoven.native_memory_require(FOUND,'ND001');ctx:=pactwoven.native_delegation_actor_locked(p_actor,r.site_id,false);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.grant_id) FOR SHARE;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,p_id);
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id);
 SELECT * INTO c FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(r.environment,r.organization_id,p_id,r.checkpoint_version);
 SELECT publication->'result' INTO result_body FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id);
 state:=r.phase;reason:=r.reason;
 IF state NOT IN('completed','cancelled') AND(g.body->'revocation'<>'null'::jsonb OR pactwoven.supplier_time(g.body->'expiresAt')<=clock_timestamp() OR t.authority<>pactwoven.native_delegation_reference(g)) THEN state:='blocked';reason:='authority';END IF;
 IF c.version IS NOT NULL OR result_body IS NOT NULL THEN
  BEGIN
   -- Stored plaintext may carry evidence from an earlier generation. Validate
   -- every consumed original publication, not only the latest receipt list.
   -- The original child context remains intact inside validate_inputs; only
   -- its separate root disclosure check uses the current human reader.
   IF result_body IS NOT NULL AND pactwoven.native_delegation_refresh_epoch(r.environment,r.organization_id,p_id)>0 THEN PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_completions binding JOIN pactwoven.native_delegation_root_completions done ON(done.environment,done.organization_id,done.root_task_id,done.generation,done.digest)=(binding.environment,binding.organization_id,binding.root_task_id,binding.generation,binding.publication_digest) WHERE(binding.environment,binding.organization_id,binding.root_task_id)=(r.environment,r.organization_id,p_id)),'NM009');END IF;
   projection_until:=least(pactwoven.native_memory_time(ctx->'validUntil'),clock_timestamp()+interval '1 minute');
   FOR input IN SELECT * FROM pactwoven.native_delegation_root_inputs WHERE(environment,organization_id,root_task_id)=(r.environment,r.organization_id,p_id) AND(pactwoven.native_delegation_refresh_epoch(r.environment,r.organization_id,p_id)=0 OR generation=coalesce((SELECT done.generation FROM pactwoven.native_delegation_root_completions done WHERE(done.environment,done.organization_id,done.root_task_id)=(r.environment,r.organization_id,p_id)),c.generation)) ORDER BY generation,id LOOP
    PERFORM pactwoven.native_memory_require(pactwoven.native_memory_scope(input.context_binding)=pactwoven.native_memory_scope(ctx)
     AND input.context_binding#>>'{usage,taskId}'=p_id AND input.context_binding#>>'{usage,generation}'=input.generation::text
     AND input.digest=pactwoven.native_delegation_hash(input.body),'NM009');
    projection_ctx:=input.context_binding||jsonb_build_object('reader',ctx->'reader','purpose','human_review','validUntil',pactwoven.mandate_instant(projection_until));
    PERFORM pactwoven.native_delegation_refresh_input_binding(projection_ctx,input.body);
    checked:=pactwoven.native_delegation_root_validate_inputs(projection_ctx,input.body->'choices');
    PERFORM pactwoven.native_memory_require(checked->'results'=input.body->'results' AND checked->'dataValidUntil'=input.body->'dataValidUntil','NM005');
    deadline:=least(deadline,input.data_valid_until);
   END LOOP;
   deadline:=least(deadline,pactwoven.native_memory_time(result_body->'evidenceValidUntil'));
   PERFORM pactwoven.native_memory_require(projection_until>clock_timestamp() AND(deadline IS NULL OR deadline>clock_timestamp()),'NM008');
  EXCEPTION WHEN SQLSTATE 'NM001' OR SQLSTATE 'NM002' OR SQLSTATE 'NM004' OR SQLSTATE 'NM005' OR SQLSTATE 'NM006' OR SQLSTATE 'NM007' OR SQLSTATE 'NM008' OR SQLSTATE 'NM009' OR SQLSTATE 'ND001' THEN
   unavailable:=true;c.body:=NULL;result_body:=NULL;
  END;
 END IF;
 PERFORM pactwoven.native_memory_notes_deadline(ctx);
 RETURN jsonb_build_object('scope',pactwoven.native_memory_scope(ctx),'id',p_id,'title',r.title,'prompt',r.prompt,'controlVersion',r.control_version,'state',state,'reason',reason,
  'updatedAt',pactwoven.mandate_instant(r.updated_at),'expiresAt',g.body->'expiresAt','evidenceUnavailable',unavailable,
  'checkpointVersion',r.checkpoint_version,'checkpoint',c.body,'checkpointHistorical',coalesce(c.generation<>t.generation,false),'attempt',t.attempt,'attemptLimit',t.attempt_limit,'generation',t.generation,
  'coverage',pactwoven.native_delegation_root_coverage(r.environment,r.organization_id,p_id),
  'result',result_body,'domainCompletion',false);
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_recovery_cost(e text,o text,r text) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT count(*)::integer FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,o,r,pactwoven.native_delegation_refresh_epoch(e,o,r))) s
 JOIN pactwoven.native_delegation_tasks t ON(t.environment,t.organization_id,t.id)=(e,o,s->>'taskId') WHERE t.state NOT IN('settled','cancelled') $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_refresh_recovery_fits(e text,o text,r text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT g.children_created+pactwoven.native_delegation_refresh_pending(e,o,r)+pactwoven.native_delegation_refresh_recovery_cost(e,o,r)<=(g.body#>>'{scope,limits,maxChildren}')::integer
 FROM pactwoven.native_delegation_root_runs root JOIN pactwoven.native_delegation_grants g ON(g.environment,g.organization_id,g.id)=(root.environment,root.organization_id,root.grant_id)
 WHERE(root.environment,root.organization_id,root.root_task_id)=(e,o,r)),false) $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_fence(r pactwoven.native_delegation_root_runs,why text,root_state text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ep bigint;l pactwoven.native_delegation_refresh_lineages;t pactwoven.native_delegation_tasks;root pactwoven.native_delegation_tasks;b jsonb;slots jsonb;s jsonb;changed boolean:=false;BEGIN
 ep:=pactwoven.native_delegation_refresh_epoch(r.environment,r.organization_id,r.root_task_id);
 IF ep>0 THEN
  SELECT * INTO root FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,r.root_task_id);
  slots:=pactwoven.native_delegation_refresh_slots(r.environment,r.organization_id,r.root_task_id,ep);
  IF why<>'cancel' AND root.attempt<root.attempt_limit AND pactwoven.native_delegation_refresh_recovery_fits(r.environment,r.organization_id,r.root_task_id)
   AND(root_state='ready' OR why='pause') THEN
   FOR s IN SELECT value FROM jsonb_array_elements(slots) LOOP
    SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,s->>'taskId');
    IF t.id IS NULL OR t.state IN('settled','cancelled') THEN CONTINUE;END IF;
    SELECT * INTO l FROM pactwoven.native_delegation_refresh_lineages WHERE(environment,organization_id,root_task_id,epoch,logical_task_id)=(r.environment,r.organization_id,r.root_task_id,ep,s->>'logicalTaskId') ORDER BY revision DESC LIMIT 1;
    b:=s||jsonb_build_object('taskId',gen_random_uuid()::text,'handoffId',gen_random_uuid()::text,'requestKey',gen_random_uuid()::text,'predecessorTaskId',t.id,'kind','replacement');
    INSERT INTO pactwoven.native_delegation_refresh_lineages VALUES(r.environment,r.organization_id,r.root_task_id,ep,l.logical_task_id,l.revision+1,b->>'taskId',b->>'handoffId','replacement',b,l.original_handoff,clock_timestamp());changed:=true;
   END LOOP;
   IF changed THEN PERFORM pactwoven.native_delegation_refresh_manifest(r.environment,r.organization_id,r.root_task_id,ep);END IF;
  ELSIF why='cancel' OR(why='crash' AND root_state='paused') THEN
   INSERT INTO pactwoven.native_delegation_refresh_dispositions(environment,organization_id,root_task_id,task_id,reason)
    SELECT r.environment,r.organization_id,r.root_task_id,pending_slot.value->>'taskId',CASE WHEN why='cancel' THEN 'cancelled' ELSE 'blocked' END
    FROM jsonb_array_elements(slots) AS pending_slot(value) WHERE NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(r.environment,r.organization_id,pending_slot.value->>'taskId')) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 PERFORM pactwoven.native_delegation_root_fence_epoch0(r,why,root_state);
END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_recover(e text, limit_n integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ DECLARE candidate record;r pactwoven.native_delegation_root_runs;t pactwoven.native_delegation_tasks;answer jsonb:='[]';old_generation bigint;action text;stranded boolean;BEGIN
 PERFORM pactwoven.native_delegation_service(e,ARRAY['dispatcher']);PERFORM pactwoven.native_memory_require(limit_n BETWEEN 1 AND 20,'ND004');
 FOR candidate IN SELECT run.organization_id,run.root_task_id,run.grant_id FROM pactwoven.native_delegation_root_runs run
  JOIN pactwoven.native_delegation_tasks task ON(task.environment,task.organization_id,task.id)=(run.environment,run.organization_id,run.root_task_id)
  JOIN pactwoven.native_delegation_grants g ON(g.environment,g.organization_id,g.id)=(run.environment,run.organization_id,run.grant_id)
  WHERE run.environment=e AND run.managed AND NOT run.manual_paused AND run.phase IN('ready','running','yielded','waiting_children')
   AND g.body->'revocation'='null'::jsonb AND pactwoven.supplier_time(g.body->'expiresAt')>clock_timestamp()
   AND(task.state='ready' OR(task.state='running' AND(task.lease_until<=clock_timestamp() OR task.lease_token IS NULL)))
   AND(run.phase<>'waiting_children' OR pactwoven.native_delegation_root_wait_ready(run) OR pactwoven.native_delegation_root_wait_stranded(run,clock_timestamp()))
   AND((task.lease_token IS NOT NULL AND task.lease_until<=clock_timestamp()) OR(run.phase='waiting_children' AND pactwoven.native_delegation_root_wait_stranded(run,clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_outbox outbox
    WHERE(outbox.environment,outbox.organization_id,outbox.task_id,outbox.generation)=(task.environment,task.organization_id,task.id,task.generation)
     AND(outbox.state='pending' OR(outbox.state='publishing' AND outbox.lease_until>clock_timestamp()))))
  ORDER BY run.updated_at,run.organization_id COLLATE "C",run.root_task_id COLLATE "C" LIMIT limit_n LOOP
  BEGIN
   PERFORM pactwoven.native_delegation_grant_locked(e,candidate.organization_id,candidate.grant_id);
   SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,candidate.organization_id,candidate.root_task_id) FOR UPDATE;
   SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,candidate.organization_id,candidate.root_task_id) FOR UPDATE;
   IF r.manual_paused OR r.phase NOT IN('ready','running','yielded','waiting_children') OR t.state NOT IN('ready','running') THEN CONTINUE;END IF;
   IF t.state='running' AND t.lease_token IS NOT NULL AND t.lease_until>clock_timestamp() THEN CONTINUE;END IF;
   stranded:=r.phase='waiting_children' AND pactwoven.native_delegation_root_wait_stranded(r,clock_timestamp());
   IF r.phase='waiting_children' AND NOT pactwoven.native_delegation_root_wait_ready(r) AND NOT stranded THEN CONTINUE;END IF;
   old_generation:=t.generation;
   IF NOT stranded AND(t.state='ready' OR(t.lease_token IS NULL AND r.phase IN('yielded','waiting_children'))) THEN
    IF EXISTS(SELECT 1 FROM pactwoven.native_delegation_outbox WHERE(environment,organization_id,task_id,generation)=(e,t.organization_id,t.id,t.generation)
     AND(state='pending' OR(state='publishing' AND lease_until>clock_timestamp()))) THEN CONTINUE;END IF;
    PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);
    UPDATE pactwoven.native_delegation_outbox SET state='pending',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id,generation)=(e,t.organization_id,t.id,t.generation);
    action:='redelivered';
   ELSE
    IF t.attempt>=t.attempt_limit OR r.slice_count>=256 OR NOT pactwoven.native_delegation_refresh_recovery_fits(e,t.organization_id,t.id) THEN
     UPDATE pactwoven.native_delegation_root_runs SET phase='blocked',reason=CASE WHEN r.slice_count>=256 THEN 'continuation_limit' ELSE 'attempts_exhausted' END,updated_at=clock_timestamp(),control_version=control_version+1
      WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
     PERFORM pactwoven.native_delegation_root_fence(r,'crash','paused');
     -- The terminal block reason takes precedence over the generic pause hook.
     UPDATE pactwoven.native_delegation_root_runs SET phase='blocked',reason=CASE WHEN r.slice_count>=256 THEN 'continuation_limit' ELSE 'attempts_exhausted' END WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);action:='blocked';
    ELSE
     PERFORM pactwoven.native_delegation_root_fence(r,'crash','ready');
     UPDATE pactwoven.native_delegation_tasks SET attempt=attempt+1 WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
     UPDATE pactwoven.native_delegation_root_runs SET phase='ready',reason='reconciliation',restart_required=false,wait_for='{}',control_version=control_version+1,updated_at=clock_timestamp()
      WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);action:='recovered';
    END IF;
    SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,t.id);
    INSERT INTO pactwoven.native_delegation_root_recoveries VALUES(e,t.organization_id,t.id,t.generation,old_generation,t.attempt,action,clock_timestamp());
    IF action='recovered' THEN PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);END IF;
   END IF;
   UPDATE pactwoven.native_delegation_root_runs SET updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
   answer:=answer||jsonb_build_array(jsonb_build_object('rootTaskId',t.id,'generation',t.generation,'action',action,'attempt',t.attempt));
  EXCEPTION WHEN SQLSTATE 'ND001' THEN CONTINUE;
  END;
 END LOOP;RETURN answer;
END $function$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;
 cp pactwoven.native_delegation_root_checkpoints;first_cp pactwoven.native_delegation_root_checkpoints;child pactwoven.native_delegation_tasks;
 result pactwoven.native_delegation_results;art pactwoven.native_delegation_artifacts;ep bigint;new_ep bigint;first_state jsonb;latest_state jsonb;basis jsonb;
 original jsonb;slot jsonb;slots jsonb;new_slots jsonb:='[]';choices jsonb:='[]';choice jsonb;h jsonb;original_h jsonb;item jsonb;ref_value jsonb;checked jsonb;data_ctx jsonb;
 stale boolean;expired_n integer:=0;new_task text;new_handoff text;new_key text;body jsonb;digest text;prior jsonb;answer jsonb;usage jsonb;initial_digest text;data_until timestamptz;memory_checked jsonb;
BEGIN
 PERFORM pactwoven.native_delegation_refresh_require(q,'refresh');prior:=pactwoven.native_delegation_refresh_command_lookup(e,selector,q,'refresh');IF prior IS NOT NULL THEN RETURN prior;END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id);
 ep:=pactwoven.native_delegation_refresh_epoch(e,t.organization_id,t.id);new_ep:=ep+1;
 PERFORM pactwoven.native_memory_require(t.attempt<t.attempt_limit AND r.slice_count<256,'NM007');
 PERFORM pactwoven.native_memory_require(ep=(q->>'expectedRefreshEpoch')::bigint AND r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_completions WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id)),'ND009');
 PERFORM pactwoven.native_memory_require(g.active_children=0 AND g.body->>'mode'='advise' AND g.body->>'externalEffects'='forbidden','ND001');
 SELECT * INTO cp FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,t.organization_id,t.id,r.checkpoint_version);
 BEGIN latest_state:=cp.planner_state::jsonb;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='NM009',MESSAGE='Original plan metadata unavailable';END;
 PERFORM pactwoven.native_delegation_refresh_require(latest_state,'coordinator_state');usage:=latest_state->'usage';
 IF ep=0 THEN
  SELECT * INTO first_cp FROM pactwoven.native_delegation_root_checkpoints WHERE(environment,organization_id,root_task_id,version)=(e,t.organization_id,t.id,1);
  PERFORM pactwoven.native_memory_require(first_cp.version=1 AND first_cp.input_receipts='[]'::jsonb AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_inputs i
   WHERE(i.environment,i.organization_id,i.root_task_id)=(e,t.organization_id,t.id) AND i.recorded_at<=first_cp.recorded_at),'NM009');
  BEGIN first_state:=first_cp.planner_state::jsonb;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='NM009',MESSAGE='Initial plan unavailable';END;
  PERFORM pactwoven.native_delegation_refresh_require(first_state,'coordinator_state');
  basis:=jsonb_build_object('checkpointVersion',first_cp.version,'plannerState',first_cp.planner_state,'plannerDigest',pactwoven.native_delegation_hash(first_state));
 ELSE SELECT original_plan INTO basis FROM pactwoven.native_delegation_refresh_epochs WHERE(environment,organization_id,root_task_id,epoch)=(e,t.organization_id,t.id,ep);first_state:=(basis->>'plannerState')::jsonb;END IF;
 initial_digest:=pactwoven.native_delegation_hash(jsonb_build_object('title',r.title,'prompt',r.prompt,'memoryReferences',(SELECT memory_references FROM pactwoven.native_delegation_root_note_selections WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id))));
 PERFORM pactwoven.native_memory_require(first_state->>'inputDigest'=initial_digest AND latest_state->>'inputDigest'=initial_digest
  AND jsonb_array_length(first_state->'slots') BETWEEN 1 AND 6 AND jsonb_array_length(first_state->'slots')=jsonb_array_length(latest_state->'slots')
  AND NOT(first_state->>'bounded')::boolean AND NOT(latest_state->>'bounded')::boolean,'NM009');
 slots:='[]';
 FOR original IN SELECT value FROM jsonb_array_elements(first_state->'slots') LOOP
  IF ep=0 THEN
   SELECT value INTO slot FROM jsonb_array_elements(latest_state->'slots') WHERE value#>>'{assignment,stepId}'=original#>>'{assignment,stepId}';
   PERFORM pactwoven.native_memory_require(slot IS NOT NULL AND slot->'assignment'=original->'assignment','NM009');
   slot:=slot||jsonb_build_object('logicalTaskId',original->>'taskId','originalTaskId',original->>'taskId','predecessorTaskId',NULL,'kind','retained');
  ELSE SELECT value INTO slot FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.id,ep)) WHERE value->>'logicalTaskId'=original->>'taskId';END IF;
  PERFORM pactwoven.native_memory_require(slot IS NOT NULL AND slot->'assignment'=original->'assignment','NM009');
  SELECT * INTO child FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,slot->>'taskId');
  PERFORM pactwoven.native_memory_require(child.id IS NOT NULL AND child.root_task_id=t.id AND child.depth=1 AND child.state='settled' AND child.authority=t.authority
   AND child.handoff_id=slot->>'handoffId' AND EXISTS(SELECT 1 FROM pactwoven.native_delegation_root_assignments a WHERE(a.environment,a.organization_id,a.task_id)=(e,t.organization_id,child.id)
    AND a.assignment=original->'assignment' AND(a.handoff_id,a.generation,a.assignment_version)=(child.handoff_id,child.generation,child.assignment_version)),'NM009');
  SELECT * INTO result FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(e,t.organization_id,child.handoff_id);
  PERFORM pactwoven.native_memory_require(result.handoff_id IS NOT NULL AND result.publication#>>'{result,outcome}' IN('advice_ready','failed') AND result.digest=pactwoven.native_delegation_hash(result.publication)
   AND(result.generation,result.assignment_version)=(child.generation,child.assignment_version),'NM009');
  SELECT envelope.body INTO h FROM pactwoven.native_delegation_envelopes envelope WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(e,t.organization_id,child.handoff_id,child.assignment_version,child.generation,'handoff');
  PERFORM pactwoven.native_memory_require(h IS NOT NULL AND h->'inputArtifacts'='[]'::jsonb AND h->'recipient'=child.identity AND h->'authority'=child.authority,'NM009');
  SELECT envelope.body INTO original_h FROM pactwoven.native_delegation_root_assignments assigned JOIN pactwoven.native_delegation_envelopes envelope ON(envelope.environment,envelope.organization_id,envelope.handoff_id,envelope.assignment_version,envelope.generation,envelope.kind)=(assigned.environment,assigned.organization_id,assigned.handoff_id,assigned.assignment_version,assigned.generation,'handoff') WHERE(assigned.environment,assigned.organization_id,assigned.root_task_id,assigned.task_id)=(e,t.organization_id,t.id,original->>'taskId') AND assigned.assignment=original->'assignment' AND assigned.handoff_id=original->>'handoffId' AND assigned.request_key=original->>'requestKey';
  PERFORM pactwoven.native_memory_require(original_h IS NOT NULL AND h-ARRAY['handoffId','childTaskId','issuedAt','deadlineAt','correlationId','generation','assignmentVersion']=original_h-ARRAY['handoffId','childTaskId','issuedAt','deadlineAt','correlationId','generation','assignmentVersion'],'NM009');
  choice:=jsonb_build_object('handoffId',child.handoff_id,'publicationDigest',result.digest);IF result.publication#>>'{result,outcome}'='advice_ready' THEN choices:=choices||jsonb_build_array(choice);END IF;
  stale:=result.publication#>>'{result,outcome}'='advice_ready' AND pactwoven.native_memory_time(result.publication#>'{result,evidenceValidUntil}')<=clock_timestamp();
  PERFORM pactwoven.native_memory_require(result.publication#>>'{result,outcome}'='failed' OR jsonb_array_length(result.publication->'artifacts')>0,'NM009');
  FOR item IN SELECT value FROM jsonb_array_elements(result.publication->'artifacts') LOOP
   ref_value:=item->'reference';SELECT * INTO art FROM pactwoven.native_delegation_artifacts WHERE(environment,organization_id,id,revision)=(e,t.organization_id,ref_value->>'artifactId',(ref_value->>'revision')::bigint);
   PERFORM pactwoven.native_memory_require(art.id IS NOT NULL AND art.task_id=child.id AND art.site_id=child.site_id AND art.publication_digest=result.digest
    AND art.reference=ref_value AND art.body=item->'body' AND ref_value->>'digest'=pactwoven.native_delegation_hash(art.body),'NM009');stale:=stale OR art.valid_until<=clock_timestamp();
  END LOOP;
  -- Exact original selected revisions, semantic freshness and both service ACLs
  -- are re-evaluated without reviving an old task's expired authority clock.
  IF jsonb_array_length(original#>'{assignment,memoryReferences}')>0 THEN PERFORM pactwoven.native_memory_lock_scope(ctx,false);END IF;
  FOR ref_value IN SELECT value FROM jsonb_array_elements(original#>'{assignment,memoryReferences}') LOOP
   memory_checked:=pactwoven.native_memory_evaluate_locked(pactwoven.native_memory_data_context(ctx),ref_value,date_trunc('milliseconds',clock_timestamp()));
   data_until:=least(data_until,pactwoven.native_memory_time(memory_checked#>'{selection,validUntil}'));
   data_ctx:=jsonb_set(pactwoven.native_memory_data_context(ctx),'{reader}',jsonb_build_object('kind','agent','id',child.identity->>'serviceId'));
   memory_checked:=pactwoven.native_memory_evaluate_locked(data_ctx,ref_value,date_trunc('milliseconds',clock_timestamp()));
   data_until:=least(data_until,pactwoven.native_memory_time(memory_checked#>'{selection,validUntil}'));
  END LOOP;
  IF stale THEN
   PERFORM pactwoven.native_memory_require(child.capability IN('research_public_sources','draft_advice','read_scoped_memory'),'NM008');
   expired_n:=expired_n+1;new_task:=gen_random_uuid()::text;new_handoff:=gen_random_uuid()::text;new_key:=gen_random_uuid()::text;
   body:=jsonb_build_object('logicalTaskId',original->>'taskId','originalTaskId',original->>'taskId','predecessorTaskId',child.id,'taskId',new_task,'handoffId',new_handoff,'requestKey',new_key,'assignment',original->'assignment','kind','replacement');
  ELSE
   checked:=pactwoven.native_delegation_root_validate_inputs(ctx,jsonb_build_array(choice));
   data_until:=least(data_until,pactwoven.native_memory_time(checked->'dataValidUntil'),pactwoven.native_memory_time(result.publication#>'{result,evidenceValidUntil}'));
   body:=slot||jsonb_build_object('kind','retained','predecessorTaskId',child.id);
  END IF;
  slots:=slots||jsonb_build_array(jsonb_build_object('body',body,'handoff',h));
 END LOOP;
 SELECT jsonb_agg(value ORDER BY value->>'handoffId' COLLATE "C",value->>'publicationDigest' COLLATE "C") INTO choices FROM jsonb_array_elements(choices);
 PERFORM pactwoven.native_memory_require(choices=q->'results','ND009');
 PERFORM pactwoven.native_memory_require(expired_n>0,'NM008');
 PERFORM pactwoven.native_memory_require(g.children_created+pactwoven.native_delegation_refresh_pending(e,t.organization_id,t.id)+expired_n<=(g.body#>>'{scope,limits,maxChildren}')::integer,'NM007');
 -- Every live/successful task must belong to proven current slots; previous
 -- refresh predecessors are covered only through the immutable prior manifest.
 IF ep=0 THEN PERFORM pactwoven.native_memory_require(NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks x WHERE(x.environment,x.organization_id,x.root_task_id)=(e,t.organization_id,t.id) AND x.depth>0 AND x.state<>'cancelled'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(latest_state->'slots') s WHERE s->>'taskId'=x.id)),'NM009');END IF;
 INSERT INTO pactwoven.native_delegation_refresh_epochs VALUES(e,t.organization_id,t.id,new_ep,ep,basis,usage,q->>'requestKey',clock_timestamp());
 FOR item IN SELECT value FROM jsonb_array_elements(slots) LOOP body:=item->'body';
  INSERT INTO pactwoven.native_delegation_refresh_lineages VALUES(e,t.organization_id,t.id,new_ep,body->>'logicalTaskId',1,body->>'taskId',body->>'handoffId',body->>'kind',body,item->'handoff',clock_timestamp());END LOOP;
 digest:=pactwoven.native_delegation_refresh_manifest(e,t.organization_id,t.id,new_ep);
 INSERT INTO pactwoven.native_delegation_root_checkpoints(environment,organization_id,root_task_id,version,generation,body,planner_state,input_receipts)
 VALUES(e,t.organization_id,t.id,r.checkpoint_version+1,t.generation+1,jsonb_build_object('stage','working','summary','Refreshing the original sources.','steps','[]'::jsonb),'','[]');
 UPDATE pactwoven.native_delegation_root_runs SET checkpoint_version=checkpoint_version+1,slice_count=slice_count+1,phase='yielded',reason='none',wait_for='{}',control_version=control_version+1,updated_at=clock_timestamp() WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id) RETURNING * INTO r;
 -- Recheck the old claim at the last pre-fence point, then atomically fence it.
 PERFORM pactwoven.native_delegation_task_locked(e,selector,true);
 UPDATE pactwoven.native_delegation_tasks SET generation=generation+1,attempt=attempt+1,lease_token=NULL,lease_until=NULL WHERE(environment,organization_id,id)=(e,t.organization_id,t.id) RETURNING * INTO t;
 UPDATE pactwoven.native_delegation_proofs SET verdict='unknown',valid_until=NULL,nonce=NULL,nonce_barrier=NULL,prepared_at=NULL,deadline_at=NULL,barrier=barrier+1 WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 UPDATE pactwoven.native_delegation_outbox SET state='suppressed',token=NULL,lease_until=NULL WHERE(environment,organization_id,task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_delegation_root_wake(e,t.organization_id,t.id,t.generation);

 answer:=jsonb_build_object('kind','refresh','requestKey',q->>'requestKey','intentDigest',pactwoven.native_delegation_hash(q),'rootTaskId',t.id,'previousGeneration',(selector->>'generation')::bigint,'generation',t.generation,
 'previousEpoch',ep,'refreshEpoch',new_ep,'attempt',t.attempt,'checkpointVersion',r.checkpoint_version,'lineageDigest',digest,'admittedTaskIds','[]'::jsonb,'pendingCount',expired_n,'continuation','yielded','domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_refresh_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','refresh',(selector->>'generation')::bigint,t.identity,q,pactwoven.native_delegation_hash(q),answer,clock_timestamp());
 -- Semantic freshness must survive every write, including durable command storage.
 PERFORM pactwoven.native_memory_require(data_until IS NULL OR data_until>clock_timestamp(),'NM008');
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp() AND t.deadline_at>clock_timestamp(),'ND001');
 RETURN answer;
END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh_dispatch(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx jsonb;t pactwoven.native_delegation_tasks;r pactwoven.native_delegation_root_runs;g pactwoven.native_delegation_grants;c pactwoven.native_delegation_refresh_current;
 l pactwoven.native_delegation_refresh_lineages;prior jsonb;h jsonb;answer jsonb;issued timestamptz;deadline timestamptz;handed jsonb;pending integer;BEGIN
 PERFORM pactwoven.native_delegation_refresh_require(q,'dispatch');prior:=pactwoven.native_delegation_refresh_command_lookup(e,selector,q,'dispatch');IF prior IS NOT NULL THEN RETURN prior;END IF;
 ctx:=pactwoven.native_delegation_root_context(e,selector,true);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 SELECT * INTO r FROM pactwoven.native_delegation_root_runs WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 SELECT * INTO g FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id);
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.id);
 PERFORM pactwoven.native_memory_require(c.epoch=(q->>'expectedRefreshEpoch')::bigint AND c.lineage_digest=q->>'lineageDigest' AND r.checkpoint_version=(q->>'expectedCheckpointVersion')::bigint,'ND009');
 SELECT * INTO l FROM pactwoven.native_delegation_refresh_lineages WHERE(environment,organization_id,root_task_id,epoch,logical_task_id)=(e,t.organization_id,t.id,c.epoch,q->>'logicalTaskId') ORDER BY revision DESC LIMIT 1;
 PERFORM pactwoven.native_memory_require(l.task_id IS NOT NULL AND l.kind='replacement' AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,l.task_id))
  AND NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_refresh_dispositions WHERE(environment,organization_id,root_task_id,task_id)=(e,t.organization_id,t.id,l.task_id))
  AND g.active_children<(g.body#>>'{scope,limits,maxConcurrentChildren}')::integer AND g.children_created+pactwoven.native_delegation_refresh_pending(e,t.organization_id,t.id)<=(g.body#>>'{scope,limits,maxChildren}')::integer,'ND009');
 issued:=date_trunc('milliseconds',clock_timestamp());deadline:=least(issued+(l.original_handoff->>'taskTimeoutMs')::integer*interval '1 millisecond',t.deadline_at,pactwoven.supplier_time(g.body->'expiresAt'));
 PERFORM pactwoven.native_memory_require(deadline>issued,'ND001');
 h:=l.original_handoff||jsonb_build_object('handoffId',l.handoff_id,'childTaskId',l.task_id,'assignmentVersion',1,'generation',1,'issuedAt',pactwoven.mandate_instant(issued),'deadlineAt',pactwoven.mandate_instant(deadline),'correlationId',gen_random_uuid()::text);
 handed:=pactwoven.native_delegation_handoff_epoch0(e,selector,h);
 INSERT INTO pactwoven.native_delegation_root_assignments VALUES(e,t.organization_id,t.id,l.task_id,l.handoff_id,l.body->>'requestKey',1,1,jsonb_build_object('requestKey',l.body->>'requestKey','handoff',h,'assignment',l.body->'assignment'),l.body->'assignment',handed);
 PERFORM pactwoven.native_delegation_root_context(e,selector,true);
 SELECT count(*) INTO pending FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.id,c.epoch)) s WHERE NOT EXISTS(SELECT 1 FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,t.organization_id,s->>'taskId'));
 answer:=jsonb_build_object('kind','dispatch','requestKey',q->>'requestKey','intentDigest',pactwoven.native_delegation_hash(q),'rootTaskId',t.id,'previousGeneration',t.generation,'generation',t.generation,'previousEpoch',c.epoch,'refreshEpoch',c.epoch,'attempt',t.attempt,
 'checkpointVersion',r.checkpoint_version,'lineageDigest',c.lineage_digest,'admittedTaskIds',jsonb_build_array(l.task_id),'pendingCount',pending,'continuation','running','domainCompletion',false);
 INSERT INTO pactwoven.native_delegation_refresh_commands VALUES(e,t.organization_id,t.id,q->>'requestKey','dispatch',t.generation,t.identity,q,pactwoven.native_delegation_hash(q),answer,clock_timestamp());RETURN answer;
END $$;
CREATE OR REPLACE FUNCTION pactwoven.native_delegation_root_refresh_operation(e text,target jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t pactwoven.native_delegation_tasks;p pactwoven.native_delegation_refresh_commands;s jsonb;BEGIN
 PERFORM pactwoven.native_delegation_refresh_require(q,'operation');PERFORM pactwoven.native_delegation_target(target,false);s:=pactwoven.native_delegation_service(e,ARRAY['coordinator']);
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,target->>'organizationId',target->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.depth=0 AND t.identity=s,'ND001');
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id) FOR UPDATE;
 SELECT * INTO p FROM pactwoven.native_delegation_refresh_commands WHERE(environment,organization_id,root_task_id,request_key)=(e,t.organization_id,t.id,q->>'requestKey');
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM pactwoven.native_memory_require(p.kind=q->>'kind' AND p.identity=s AND p.generation=(target->>'generation')::bigint AND p.intent_digest=q->>'intentDigest' AND p.intent_digest=pactwoven.native_delegation_hash(p.intent),'ND009');RETURN p.response;END $$;

CREATE OR REPLACE FUNCTION pactwoven.native_delegation_result_commit_v2(e text,selector jsonb,q jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE service jsonb;t pactwoven.native_delegation_tasks;c pactwoven.native_delegation_refresh_current;p pactwoven.native_delegation_refresh_observations;prior pactwoven.native_delegation_results;
 ctx jsonb;publication jsonb;observations jsonb;ob jsonb;item jsonb;ev jsonb;h jsonb;s jsonb;ep bigint;pd text;vd text;receipt jsonb;ids jsonb;actual_ids jsonb;observed timestamptz;until_time timestamptz;BEGIN
 PERFORM pactwoven.native_delegation_refresh_require(q,'publication');PERFORM pactwoven.native_delegation_target(selector,true);service:=pactwoven.native_delegation_service(e,ARRAY['coordinator','worker']);
 publication:=q->'publication';observations:=q->'observations';ep:=(q->>'expectedRefreshEpoch')::bigint;pd:=pactwoven.native_delegation_hash(publication);vd:=CASE WHEN observations='[]'::jsonb THEN NULL ELSE pactwoven.native_delegation_hash(observations) END;
 SELECT * INTO t FROM pactwoven.native_delegation_tasks WHERE(environment,organization_id,id)=(e,selector->>'organizationId',selector->>'taskId');
 PERFORM pactwoven.native_memory_require(t.id IS NOT NULL AND t.identity=service AND t.depth>0,'ND001');
 PERFORM 1 FROM pactwoven.native_delegation_grants WHERE(environment,organization_id,id)=(e,t.organization_id,t.grant_id) FOR UPDATE;
 SELECT * INTO prior FROM pactwoven.native_delegation_results WHERE(environment,organization_id,handoff_id)=(e,t.organization_id,t.handoff_id);
 SELECT * INTO p FROM pactwoven.native_delegation_refresh_observations WHERE(environment,organization_id,handoff_id)=(e,t.organization_id,t.handoff_id);
 IF prior.handoff_id IS NOT NULL AND p.handoff_id IS NOT NULL THEN
 PERFORM pactwoven.native_memory_require(prior.publication=publication AND p.publication_digest=pd AND p.observations=observations AND p.epoch=ep
  AND publication#>>'{result,generation}'=selector->>'generation' AND publication#>>'{result,handoffId}'=selector->>'handoffId' AND publication#>>'{result,childTaskId}'=selector->>'taskId' AND publication#>>'{result,organizationId}'=selector->>'organizationId' AND publication#>>'{result,environment}'=e AND publication#>'{result,sender}'=service,'ND009');
 RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'publicationDigest',pd,'provenanceDigest',vd);END IF;
 SELECT * INTO c FROM pactwoven.native_delegation_refresh_current WHERE(environment,organization_id,root_task_id)=(e,t.organization_id,t.root_task_id);
 IF c.epoch IS NULL THEN PERFORM pactwoven.native_memory_require(ep=0 AND observations='[]'::jsonb,'ND004');receipt:=pactwoven.native_delegation_result_commit_epoch0(e,selector,publication);
 RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',0,'publicationDigest',receipt->>'publicationDigest','provenanceDigest',NULL);END IF;
 PERFORM pactwoven.native_memory_require(c.epoch=ep AND prior.handoff_id IS NULL,'ND009');
 ctx:=pactwoven.native_delegation_task_context_locked(e,selector,'result_publish');
 SELECT value INTO s FROM jsonb_array_elements(pactwoven.native_delegation_refresh_slots(e,t.organization_id,t.root_task_id,ep)) WHERE value->>'taskId'=t.id;
 PERFORM pactwoven.native_memory_require(s IS NOT NULL AND s->>'kind'='replacement' AND s->>'handoffId'=t.handoff_id,'ND001');
 SELECT body INTO h FROM pactwoven.native_delegation_envelopes WHERE(environment,organization_id,handoff_id,assignment_version,generation,kind)=(e,t.organization_id,t.handoff_id,t.assignment_version,t.generation,'handoff');
 IF t.capability='research_public_sources' AND publication#>>'{result,outcome}'='advice_ready' THEN
 PERFORM pactwoven.native_memory_require(jsonb_array_length(observations) BETWEEN 1 AND 3 AND(SELECT count(*)=count(DISTINCT value->>'requestedUrl') FROM jsonb_array_elements(observations)),'ND004');
 ids:='[]';actual_ids:='[]';
 FOR item IN SELECT value FROM jsonb_array_elements(publication->'artifacts') LOOP
 FOR ev IN SELECT value FROM jsonb_array_elements(item#>'{body,evidence}') WHERE value->>'kind'='public_source' LOOP
 actual_ids:=actual_ids||jsonb_build_array(ev->>'id');
 PERFORM pactwoven.native_memory_require(EXISTS(SELECT 1 FROM jsonb_array_elements(observations) x WHERE x->'evidenceIds' @> jsonb_build_array(ev->>'id') AND x->>'finalUrl'=ev->>'url'
  AND x->>'observedAt'=ev->>'observedAt' AND x->>'validUntil'=ev->>'validUntil'),'NM009');END LOOP;END LOOP;
 FOR ob IN SELECT value FROM jsonb_array_elements(observations) LOOP
 observed:=pactwoven.native_memory_time(ob->'observedAt');until_time:=pactwoven.native_memory_time(ob->'validUntil');
 PERFORM pactwoven.native_memory_require(ob->>'requestedUrl' LIKE 'https://%' AND ob->>'finalUrl' LIKE 'https://%' AND ob->>'requestedUrl' !~ '[#[:space:]]' AND ob->>'finalUrl' !~ '[#[:space:]]' AND ob->>'requestedUrl' !~ '^https://[^/?#]*@' AND ob->>'finalUrl' !~ '^https://[^/?#]*@'
  AND observed>=pactwoven.native_memory_time(h->'issuedAt') AND observed<=clock_timestamp() AND until_time>clock_timestamp() AND until_time<=observed+interval '15 minutes'
  AND until_time<=date_trunc('day',observed AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '1 day'
  AND t.deadline_at>clock_timestamp() AND pactwoven.native_memory_time(publication#>'{result,evidenceValidUntil}')<=least(until_time,t.deadline_at),'NM008');
 ids:=ids||(ob->'evidenceIds');END LOOP;
 PERFORM pactwoven.native_memory_require((SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(ids)) AND
 (SELECT coalesce(jsonb_agg(value ORDER BY value::text COLLATE "C"),'[]') FROM jsonb_array_elements(ids))=(SELECT coalesce(jsonb_agg(value ORDER BY value::text COLLATE "C"),'[]') FROM jsonb_array_elements(actual_ids)),'NM009');
 ELSE PERFORM pactwoven.native_memory_require(observations='[]'::jsonb,'ND004');END IF;
 receipt:=pactwoven.native_delegation_result_commit_epoch0(e,selector,publication);
 INSERT INTO pactwoven.native_delegation_refresh_observations VALUES(e,t.organization_id,t.root_task_id,ep,t.id,t.handoff_id,pd,observations,pactwoven.native_delegation_hash(observations),clock_timestamp());
 PERFORM pactwoven.native_memory_require(pactwoven.native_memory_time(ctx->'validUntil')>clock_timestamp() AND t.deadline_at>clock_timestamp() AND(publication#>>'{result,outcome}'='failed' OR pactwoven.native_memory_time(publication#>'{result,evidenceValidUntil}')>clock_timestamp()),'ND001');
 RETURN jsonb_build_object('schemaVersion',2,'refreshEpoch',ep,'publicationDigest',receipt->>'publicationDigest','provenanceDigest',vd);END $$;

DO $$ DECLARE relation record;routine record;BEGIN
 FOR relation IN SELECT c.oid::regclass name,c.relname FROM pg_class c WHERE c.relnamespace='pactwoven'::regnamespace AND c.relkind='r' AND c.relname LIKE 'native_delegation_refresh_%' LOOP
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',relation.name);EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',relation.name);
 EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',relation.name);
 IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation.name AND polname='native_refresh_owner') THEN EXECUTE format('CREATE POLICY native_refresh_owner ON %s TO %I USING(true) WITH CHECK(true)',relation.name,current_user);END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation.name AND tgname='native_refresh_retain_rows') THEN
 EXECUTE format('CREATE TRIGGER native_refresh_retain_rows BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);
 EXECUTE format('CREATE TRIGGER native_refresh_retain_table BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);
 IF relation.relname<>'native_delegation_refresh_current' THEN EXECUTE format('CREATE TRIGGER native_refresh_immutable BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION pactwoven.financial_immutable()',relation.name);END IF;END IF;
 END LOOP;
 FOR routine IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='pactwoven'::regnamespace AND
 (p.proname LIKE 'native_delegation_refresh_%' OR p.proname LIKE 'native_delegation_%_epoch0' OR p.proname LIKE 'native_delegation_%_c3' OR p.proname IN('native_delegation_root_work_v2','native_delegation_root_materials_v2','native_delegation_root_inputs_v2','native_delegation_root_checkpoint_v2','native_delegation_root_yield_v2','native_delegation_root_complete_v2','native_delegation_root_refresh','native_delegation_root_refresh_dispatch','native_delegation_root_refresh_operation','native_delegation_result_commit_v2')) LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,pactwoven_runtime,pactwoven_native_task_api,pactwoven_native_task_worker,pactwoven_native_task_dispatcher,pactwoven_native_delegation_api,pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker,pactwoven_native_delegation_dispatcher',routine.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_work_v2(text,jsonb),pactwoven.native_delegation_root_inputs_v2(text,jsonb,jsonb),pactwoven.native_delegation_root_checkpoint_v2(text,jsonb,jsonb),pactwoven.native_delegation_root_yield_v2(text,jsonb,jsonb),pactwoven.native_delegation_root_complete_v2(text,jsonb,jsonb),pactwoven.native_delegation_root_refresh(text,jsonb,jsonb),pactwoven.native_delegation_root_refresh_dispatch(text,jsonb,jsonb),pactwoven.native_delegation_root_refresh_operation(text,jsonb,jsonb) TO pactwoven_native_delegation_coordinator;
GRANT EXECUTE ON FUNCTION pactwoven.native_delegation_root_materials_v2(text,jsonb),pactwoven.native_delegation_result_commit_v2(text,jsonb,jsonb) TO pactwoven_native_delegation_coordinator,pactwoven_native_delegation_worker;

COMMIT;
