# ECC Queue Failover & Load Balance for ServiceNow done right

Unfortunately the MID server cluster management in ServiceNow is not done in a mature way. On MID agent down always the same failover agent is selected (no load balancing in place anymore). In case of running jobs during the MID agent outage, reassigning the job to a failover agent can also cause duplicates in import jobs.

## ECC Failover MID agent issue

In case of MID server down the [MIDServerCluster] script include is designed to always select the first failover agent, so the jobs are never load balanced over a set of agents. A better way to deal with an outage is to ensure the designed number of load balance agents is always available.

### Load balance & failover rules

#### As is rule (OOB)

- MID down, select first failover agent
- MID up, select random load balance agent

#### To be rule

- Find all load balance agents (or or down), find a failover for every down load balance agent, select random load balance agent.
- If no load balance agent is defined, select random from failover

#### Capability check issue

The OOB capability check is comparing the capabilities one-by-one. If the failing agent hast e.g. 2 capabilities and the failover with one `ALL` capability will not be selected.

### Better MID Cluster Management Business Rule

The [findLoadBalancerForAgent](better-mid-cluster-mgm.js#L17) script implements the 'To be rule' and fixes the capability issue. It also only requires two GlideRecord queries to lookup the corresponding agent ('ecc_agent_cluster_member_m2m' and 'ecc_agent_capability_m2m').

#### Installation

1. Disable (active = false) the [MID Server Cluster Management] Business Rule on 'ecc_queue'
2. Create a copy of it ('insert and stay')
    1. Make sure active is true again
    2. Copy the code from [better-mid-cluster-mgm.js](better-mid-cluster-mgm.js) to the script filed
3. Add a comment to the platform upgrade run book to document the change and describe how to deal with upgrade conflicts in the future.

## ECC Queue Failover of running import jobs

ServiceNow supports to failover started jobs to a declared failover MID server. However this is can cause duplicate imports as the processed jobs (before the MID is down) will not be cleaned up automatically and the new job (on the failover MID server) will start again from the beginning (there is no alternative as by the nature of SQL and the DB the response can divert).

### Script Action to failover ECC queue jobs on MID failure

If a MID server goes down, the 'mid_server.down' event is triggered.
The script action [Fail over MID server] is listening for this event and re assigns the failed job to a failover MID server.

```javascript
var msc = new MIDServerCluster(current, "Failover");
if (!msc.clusterExists())
    continue;

newMidName = msc.getClusterAgent();
```

This is causing issues to the failed import set run as it will re-run the import SQL statement on the failover MID and lead to duplicates in the ECC queue.

To prevent from importing duplicates **ONE** of the following can be done:

- Foresee duplicates when the coalesce fields are declared on the transform map.

- Unique constraint
    1. Create a unique constraint on the import set table
    2. Clean the import set table on start of the script. As imports will fail due to constraints, add a cleanup script to the import set map or the scheduler.

        ```javascript
        //Transform Script : onStart()
        var ic = new ImportSetCleaner(map.source_table);
        ic.setDataOnly(true);
        ic.clean();

        //Scheduled Data Import : Pre script
        var ic = new ImportSetCleaner('u_import_set_table');
        ic.setDataOnly(true);
        ic.clean();
        ```

- Disable the failover event script (**suggested**, except you use discovery). Reassigning started jobs to another agent is obviously causing more issues than it solves. To prevent the platform from doing this set `active=false` on [Fail over MID server]. The only downside of this is that the DiscoveryAgents are also not reassigned.

## MID cluster debugging

Set the system property `mid_server.cluster.debug` to `true` to enable debug log in [MIDServerCluster]

## Files

### Script Include

- [MIDServerCluster], called by:
  - [MID Server Cluster Management] Business Rule
  - [Fail over MID server] Script Action

### Business Rule

- [MID Server Cluster Management] on 'ecc_queue', to re assign the job to a load balance or failover agent

### Script Action

- [Fail over MID server] on 'mid_server.down' event, to re assign all 'ready' or 'processing' jobs to a failover agent

[MIDServerCluster]: https://dev000000.service-now.com/sys_script_include.do?sys_id=f6c69a020a0006bc36db905d8d02dfc2
[MID Server Cluster Management]: https://dev000000.service-now.com/sys_script.do?sys_id=297749870a0006bc2145d31c2d2335b9
[Fail over MID server]: https://dev000000.service-now.com/sysevent_script_action.do?sys_id=f6c24d230a0006bc394931345fba7a8a
