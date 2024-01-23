(ns causal.cli
  "Command-line entry point for ElectricSQL tests."
  (:require [causal
             [cluster :as cluster]
             [lww-register :as lww]
             [postgresql :as postgresql]
             [sqlite3 :as sqlite3]
             [strong-convergence :as sc]]
            [clojure
             [set :as set]
             [string :as str]]
            [clojure.tools.logging :refer [info warn]]
            [elle
             [consistency-model :as cm]
             [graph :as g]
             [rw-register :as rw]
             [txn :as txn]]
            [jepsen
             [checker :as checker]
             [client :as client]
             [cli :as cli]
             [control :as c]
             [generator :as gen]
             [nemesis :as nemesis]
             [os :as os]
             [store :as store]
             [tests :as tests]
             [util :as u]]
            [jepsen.checker.timeline :as timeline]
            [jepsen.nemesis.combined :as nc]
            [jepsen.os.debian :as debian]))

(def workloads
  "A map of workload names to functions that take CLI options and return
  workload maps."
  {:lww-register lww/workload
   :none         (fn [_] tests/noop-test)})

(def all-workloads
  "A collection of workloads we run by default."
  [:lww-register])

(def all-nemeses
  "Combinations of nemeses for tests"
  [[]
   [:pause]
   [:partition]
   [:pause :partition]
   [:kill]])

(def special-nemeses
  "A map of special nemesis names to collections of faults"
  {:none []
   :all  [:pause :partition :kill]})

(defn parse-nemesis-spec
  "Takes a comma-separated nemesis string and returns a collection of keyword
  faults."
  [spec]
  (->> (str/split spec #",")
       (map keyword)
       (mapcat #(get special-nemeses % [%]))))

(defn parse-nodes-spec
  "Takes a comma-separated nodes string and returns a collection of node names."
  [spec]
  (->> (str/split spec #",")
       (map str/trim)))

(def short-consistency-name
  "A map of consistency model names to a short name."
  {:strong-session-consistent-view "ss-consistent-view"})

(defn causal-test
  "Given options from the CLI, constructs a test map."
  [opts]
  (let [workload-name (:workload opts)
        workload ((workloads workload-name) opts)
        db       (cluster/db)
        nemesis  (nc/nemesis-package
                  {:db db
                   :nodes (:nodes opts)
                   :faults (:nemesis opts)
                   :partition {:targets [:one :minority-third :majority]}
                   :pause {:targets [:one :minority :majority :all]}
                   :kill  {:targets [["n1" "n2" "n3"]]}
                   :packet {:targets   [:one :minority :majority :all]
                            :behaviors [{:delay {}}]}
                   :interval (:nemesis-interval opts nc/default-interval)})]
    (merge tests/noop-test
           opts
           {:name (str "Electric"
                       " " (name workload-name)
                       " " (str/join "," (->> (:consistency-models opts)
                                              (map #(short-consistency-name % (name %)))))
                       " " (str/join "," (map name (:nemesis opts))))
            :os debian/os
            :db db
            :checker (checker/compose
                      {:perf (checker/perf
                              {:nemeses (:perf nemesis)})
                       :timeline (timeline/html)
                       :stats (checker/stats)
                       :exceptions (checker/unhandled-exceptions)
                       :logs-client     (checker/log-file-pattern #"SatelliteError\:" sqlite3/log-file-short)
                       :logs-postgresql (checker/log-file-pattern #".*ERROR\:  deadlock detected.*" postgresql/log-file-short)
                       ;; TODO: :logs-electricsql
                       :strong-convergence (sc/final-reads)
                       :workload (:checker workload)})
            :client    (:client workload)
            :nemesis   (:nemesis nemesis)
            :generator (gen/phases
                        (gen/log "Workload with nemesis")
                        (->> (:generator workload)
                             (gen/stagger    (/ (:rate opts)))
                             (gen/nemesis    (:generator nemesis))
                             (gen/time-limit (:time-limit opts)))

                        (gen/log "Final nemesis")
                        (gen/nemesis (:final-generator nemesis))

                        (gen/log "Final workload")
                        (:final-generator workload))})))

(def cli-opts
  "Command line options"
  [[nil "--consistency-models MODELS" "What consistency models to check for."
    :default [:strong-session-consistent-view]
    :parse-fn parse-nemesis-spec
    :validate [(partial every? cm/all-models)
               (str "Must be one or more of " cm/all-models)]]

   [nil "--linearizable-keys?" "Use the realtime process order to derive a version order, i.e. Last Write Wins."]

   [nil "--key-count NUM" "Number of keys in active rotation."
    :default  10
    :parse-fn parse-long
    :validate [pos? "Must be a positive integer"]]

   [nil "--min-txn-length NUM" "Minimum number of operations in a transaction."
    :default  1
    :parse-fn parse-long
    :validate [pos? "Must be a positive integer"]]

   [nil "--max-txn-length NUM" "Maximum number of operations in a transaction."
    :default  4
    :parse-fn parse-long
    :validate [pos? "Must be a positive integer"]]

   [nil "--max-writes-per-key NUM" "Maximum number of writes to any given key."
    :default  256
    :parse-fn parse-long
    :validate [pos? "Must be a positive integer."]]

   [nil "--nemesis FAULTS" "A comma-separated list of nemesis faults to enable"
    :parse-fn parse-nemesis-spec
    :validate [(partial every? #{:pause :partition :kill})
               "Faults must be partition, pause, or kill, or the special faults all or none."]]

   [nil "--nemesis-interval SECS" "Roughly how long between nemesis operations."
    :default 5
    :parse-fn read-string
    :validate [pos? "Must be a positive number."]]

   [nil "--noop-nodes NODES" "A comma-separated list of nodes that should get noop clients"
    :parse-fn parse-nodes-spec
    :validate [(partial every? #{"postgresql" "electricsql" "n1" "n2" "n3" "n4" "n5"})
               (str "Nodes must be " #{"postgresql" "electricsql" "n1" "n2" "n3" "n4" "n5"})]]

   ["-r" "--rate HZ" "Approximate request rate, in hz"
    :default 100
    :parse-fn read-string
    :validate [pos? "Must be a positive number."]]

   ["-w" "--workload NAME" "What workload should we run?"
    :default  :lww-register
    :parse-fn keyword
    :missing  (str "Must specify a workload: " (cli/one-of workloads))
    :validate [workloads (cli/one-of workloads)]]])

(defn all-tests
  "Turns CLI options into a sequence of tests."
  [opts]
  (let [nemeses   (if-let [n (:nemesis opts)] [n] all-nemeses)
        workloads (if-let [w (:workload opts)] [w] all-workloads)]
    (for [n nemeses, w workloads, _i (range (:test-count opts))]
      (causal-test (assoc opts :nemesis n :workload w)))))

(defn opt-fn
  "Transforms CLI options before execution."
  [parsed]
  (let [nodes (->> (get-in parsed [:options :nodes])
                   (into #{}))]
    (assert (contains? nodes "postgresql")  "PostgreSQL is required")
    (assert (contains? nodes "electricsql") "ElectricSQL is required"))
  parsed)

(defn -main
  "CLI.
   
   `lein run` to list commands."
  [& args]
  (cli/run! (merge (cli/single-test-cmd {:test-fn  causal-test
                                         :opt-spec cli-opts
                                         :opt-fn   opt-fn})
                   (cli/test-all-cmd {:tests-fn all-tests
                                      :opt-spec cli-opts
                                      :opt-fn   opt-fn})
                   (cli/serve-cmd))
            args))
