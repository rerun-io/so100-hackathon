# SO-101 leader URDF

`so101_leader.urdf` + `assets/` come from [norma-core/norma-core](https://github.com/norma-core/norma-core)
(MIT license), path `software/station/clients/station-viewer/public/devices/so101/`.
Geometry derives from [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100)
(Apache-2.0), which ships no leader URDF of its own (follower-only simulation models).

Used for the leader arm (handle + trigger); revolute joints are named "1".."6" matching the
bus motor ids, joint 6 drives the trigger.
