import { UpdatableMessage } from "@/entities/UpdatableMessage";
import { ProjectBinding } from "@/models/project-binding.model";
import { GitLabPipelineEvent } from "@/types/gitlab";
import moment from "moment";
import discordService from "./discord.service";
import gitlabService from "./gitlab.service";

interface Pipeline {
  id: number;
  projectId: string;
  projectName: string;
  projectUrl: string;
  author: string;
  jobs: Job[];
  status: string;
  messages: UpdatableMessage[];
  logString: string;
  finished: boolean;
  title: string;
}

interface Job {
  id: number;
  stage: string[];
  name: string;
  pipelineId: string;
  finished: boolean;
  status: string;
  duration: number;
  logString: string;
}

class CiService {
  pipelines: {
    [pipelineId: number]: Pipeline;
  } = {};

  async pipelineEvent(webhookPayload: GitLabPipelineEvent) {
    const pipelineId = webhookPayload.object_attributes.id.toString();
    const projectId = webhookPayload.project.id;
    if (typeof this.pipelines[pipelineId] === "undefined") {
      this.pipelines[pipelineId] = {
        id: pipelineId,
        projectId: webhookPayload.project.id,
        projectName: webhookPayload.project.name,
        projectUrl: webhookPayload.project.web_url,
        status: webhookPayload.object_attributes.status as string,
        author: webhookPayload.user.name,
        messages: [],
        jobs: webhookPayload.builds.map((job) => ({
          id: job.id,
          stage: job.stage,
          status: job.status,
          duration: job.duration,
          name: job.name,
          logString: "",
          pipelineId,
          finished: false,
        })),
        finished: false,
        logString: "Waiting for outputs...",
        title: `Deployment #${webhookPayload.object_attributes.id}`,
      };
      const projectBinding = await ProjectBinding.findOne({
        gitlabId: projectId,
      });
      const threadTitle = `Deployment #${webhookPayload.object_attributes.id}`;
      const threadContent = `Deployment [#${webhookPayload.object_attributes.id}](<${webhookPayload.object_attributes.url}>)`;
      const thread = await discordService.createThread(
        projectBinding?.channel.id,
        threadTitle,
        threadContent
      );
      const msg = new UpdatableMessage(
        projectBinding?.channel.id,
        thread.id,
        this.generatePipelineMessage(this.pipelines[pipelineId])
      );
      this.pipelines[pipelineId].messages.push(msg);
      console.log("Going to send message");
      msg.send().catch((e) => {
        console.log("Failed to send message", e.message);
      });
      this.watchBuild(Number(pipelineId));
    } else {
      this.pipelines[pipelineId].status =
        webhookPayload.object_attributes.status;
      this.pipelines[pipelineId].jobs = this.pipelines[pipelineId].jobs.map(
        (job) => {
          const newJobData = webhookPayload.builds.find(
            (x) => x?.id === job?.id
          );
          if (newJobData) {
            job.status = newJobData.status;
            job.duration = newJobData.duration;
          }
          return job;
        }
      );
      await this.updatePipelineMessage(Number(pipelineId));
      if (
        this.pipelines[pipelineId].jobs.filter((x) =>
          ["pending", "running"].includes(x.status)
        ).length === 0
      ) {
        this.pipelines[pipelineId].finished = true;
        await this.updatePipelineMessage(Number(pipelineId));
        delete this.pipelines[pipelineId];
      }
    }
  }

  async jobEvent(jobEventPayload: any) {
    const pipelineId = jobEventPayload.pipeline_id;
    if (!this.pipelines[pipelineId]) return;
    this.pipelines[pipelineId].jobs = this.pipelines[pipelineId].jobs.map(
      (job) => {
        if (job.id === jobEventPayload.build_id) {
          job.status = jobEventPayload.build_status;
          job.duration = jobEventPayload.build_duration;
        }
        return job;
      }
    );
    await this.updatePipelineMessage(pipelineId);
  }

  async updatePipelineMessage(pipelineId: number) {
    const pipeline = this.pipelines[pipelineId];
    const message = this.generatePipelineMessage(pipeline);
    pipeline.messages.forEach(async (msg) => {
      await msg.editText(message, `${pipeline.title} - ${pipeline.status}`);
    });
    if (pipeline.finished) {
      pipeline.messages?.[0].close();
    }
  }

  generatePipelineMessage(pipeline: Pipeline) {
    let message = `*[${pipeline.status.toUpperCase()}] DEPLOYMENT*\n\n`;
    message += `[${moment().format("HH:mm - DD/MM/YYYY")}]\n${
      pipeline.author
    } triggered deployment in [${pipeline.projectName}](<${
      pipeline.projectUrl
    }>)\n\n`;
    message += `Stages:\n`;
    message +=
      "```text\n" +
      pipeline.jobs
        .sort((a, b) => {
          return a.id - b.id;
        })
        .map((stage: any) => {
          const statusIcon = ["success"].includes(stage.status)
            ? "🟢"
            : stage.status === "failed"
            ? "🔴"
            : stage.status === "canceled" || stage.status === "skipped"
            ? "⚪️"
            : stage.status === "running"
            ? "🔵️"
            : "🟡";
          return `${statusIcon} ${stage.stage}: ${stage.name}`;
        })
        .join("\n") +
      "```\n";
    if (!pipeline.finished && pipeline.status !== "success") {
      message +=
        "```shell\n-------- BUILD LOG --------\n" +
        pipeline.logString +
        "\n--------------------------```";
    }
    return message;
  }

  watchBuild(pipelineId: number) {
    if (this.pipelines[pipelineId]) {
      console.log("Watching for pipeline...");
      const timeOutSpareTime = 1000; // every second
      const linesLimit = 10;
      const runWatch = () =>
        setTimeout(async () => {
          const pipeline = this.pipelines[pipelineId];
          const runningJobs = pipeline.jobs
            .filter((job) => job.status === "running")
            .sort((a, b) => b.id - a.id);
          const lastJob = runningJobs.pop();
          if (lastJob) {
            this.pipelines[pipelineId].logString =
              await gitlabService.getLastJobLogLines(
                pipeline.projectId,
                pipelineId,
                lastJob.id,
                linesLimit
              );
            await this.updatePipelineMessage(pipelineId);
            if (this.pipelines[pipelineId].finished) {
              console.log(
                "Pipeline is finished, not required to run watch anymore, status:",
                pipeline.status
              );
            } else runWatch();
          }
        }, timeOutSpareTime);

      runWatch();
    }
  }
}

export default new CiService();
